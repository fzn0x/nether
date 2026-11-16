package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

// AI keeps the AI providers the user has set up on this device (ADR 0068):
// each provider's address and model in ai.json beside the list of vaults,
// and its key in the system's keychain, as server tokens are kept, never
// in a file or a vault. The page reads a key when it sends a request, and
// Go's fetch sends it, so any address works, a local model's included.
type AI struct {
	file    string
	secrets secretStore
	mu      sync.Mutex
}

// AIProvider is a provider set up on this device, without its key.
type AIProvider struct {
	// ID names the provider here, and its key in the keychain.
	ID string `json:"id"`
	// Name is what the user calls it, as "Ollama" or "Work's Claude".
	Name string `json:"name"`
	// Kind is how it is spoken to: "openai" for an OpenAI-compatible
	// endpoint, "anthropic" for Anthropic's Messages API.
	Kind string `json:"kind"`
	// URL is its API's address, as http://localhost:11434/v1.
	URL string `json:"url"`
	// Model is the model to chat with, as the provider names it.
	Model string `json:"model"`
	// HasKey says whether the keychain holds a key for it.
	HasKey bool `json:"hasKey"`
}

// AISettings are the providers set up on this device, and the one vaults
// use unless they choose another.
type AISettings struct {
	Providers []AIProvider `json:"providers"`
	Default   string       `json:"default"`
}

func NewAI(data string, secrets secretStore) *AI {
	return &AI{file: filepath.Join(data, "ai.json"), secrets: secrets}
}

// aiKeyName is where the keychain keeps a provider's key.
func aiKeyName(id string) string {
	return "ai " + id
}

// providerURL checks an API's address: http or https, with a host, and no
// credentials, query or fragment; a path such as /v1 is kept.
func providerURL(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" ||
		parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("%q is not an API's address", raw)
	}
	return parsed.Scheme + "://" + parsed.Host + strings.TrimRight(parsed.EscapedPath(), "/"), nil
}

// List returns the providers set up on this device and the default one.
func (a *AI) List() (AISettings, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.read()
}

// Save adds a provider, or changes one with its ID, and returns it as kept.
// A new provider gets an ID, and is the default when it is the first.
func (a *AI) Save(provider AIProvider) (AIProvider, error) {
	provider.Name = strings.TrimSpace(provider.Name)
	provider.Model = strings.TrimSpace(provider.Model)
	if provider.Name == "" || provider.Model == "" {
		return AIProvider{}, errors.New("a provider needs a name and a model")
	}
	if provider.Kind != "openai" && provider.Kind != "anthropic" {
		return AIProvider{}, fmt.Errorf("%q is not a kind of provider", provider.Kind)
	}
	address, err := providerURL(provider.URL)
	if err != nil {
		return AIProvider{}, err
	}
	provider.URL = address
	a.mu.Lock()
	defer a.mu.Unlock()
	settings, err := a.read()
	if err != nil {
		return AIProvider{}, err
	}
	if provider.ID == "" {
		provider.ID = newUUIDv7(time.Now())
		provider.HasKey = false
		settings.Providers = append(settings.Providers, provider)
	} else {
		at := settings.index(provider.ID)
		if at < 0 {
			return AIProvider{}, fmt.Errorf("no provider %q is set up here", provider.ID)
		}
		// Whether there is a key is the keychain's to say, through SetKey.
		provider.HasKey = settings.Providers[at].HasKey
		settings.Providers[at] = provider
	}
	if settings.index(settings.Default) < 0 {
		settings.Default = provider.ID
	}
	return provider, writeJSON(a.file, settings)
}

// SetKey keeps a provider's key in the keychain; an empty key removes it,
// for a local model that needs none.
func (a *AI) SetKey(id string, key string) error {
	if len(key) > mygo.MaxSecretSize {
		return errors.New("that key is too long")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	settings, err := a.read()
	if err != nil {
		return err
	}
	at := settings.index(id)
	if at < 0 {
		return fmt.Errorf("no provider %q is set up here", id)
	}
	if key == "" {
		if err := a.secrets.Delete(aiKeyName(id)); err != nil && !errors.Is(err, mygo.ErrSecretNotFound) {
			return err
		}
	} else if err := a.secrets.Set(aiKeyName(id), []byte(key)); err != nil {
		return err
	}
	settings.Providers[at].HasKey = key != ""
	return writeJSON(a.file, settings)
}

// Key returns a provider's key; empty when the keychain has none.
func (a *AI) Key(id string) (string, error) {
	if id == "" {
		return "", nil
	}
	key, err := a.secrets.Get(aiKeyName(id))
	if errors.Is(err, mygo.ErrSecretNotFound) {
		return "", nil
	}
	return string(key), err
}

// Remove forgets a provider, and its key leaves the keychain. When it was
// the default, the first left takes its place.
func (a *AI) Remove(id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	settings, err := a.read()
	if err != nil {
		return err
	}
	if err := a.secrets.Delete(aiKeyName(id)); err != nil && !errors.Is(err, mygo.ErrSecretNotFound) {
		return err
	}
	next := []AIProvider{}
	for _, provider := range settings.Providers {
		if provider.ID != id {
			next = append(next, provider)
		}
	}
	settings.Providers = next
	if settings.index(settings.Default) < 0 {
		settings.Default = ""
		if len(next) > 0 {
			settings.Default = next[0].ID
		}
	}
	return writeJSON(a.file, settings)
}

// SetDefault makes a provider the one vaults use unless they choose another.
func (a *AI) SetDefault(id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	settings, err := a.read()
	if err != nil {
		return err
	}
	if settings.index(id) < 0 {
		return fmt.Errorf("no provider %q is set up here", id)
	}
	settings.Default = id
	return writeJSON(a.file, settings)
}

func (s AISettings) index(id string) int {
	for at, provider := range s.Providers {
		if provider.ID == id {
			return at
		}
	}
	return -1
}

func (a *AI) read() (AISettings, error) {
	empty := AISettings{Providers: []AIProvider{}}
	data, err := os.ReadFile(a.file)
	if errors.Is(err, fs.ErrNotExist) {
		return empty, nil
	}
	if err != nil {
		return AISettings{}, err
	}
	var settings AISettings
	if err := json.Unmarshal(data, &settings); err != nil {
		// A damaged file is started again; the keys stay in the keychain.
		return empty, nil
	}
	if settings.Providers == nil {
		settings.Providers = []AIProvider{}
	}
	return settings, nil
}
