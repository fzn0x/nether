package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

// Connections keeps the person's connections to services on this device
// (ADR 0090): each one's name, the address it is shown by and the origins
// its requests may reach in connections.json beside the list of vaults,
// and its secret, a feed's whole address, a password or a token, in the
// system's keychain, never in a file or a vault. The page reads a secret
// when it sends a plugin's request, and Go's fetch sends it; the plugin
// never sees it.
type Connections struct {
	file    string
	secrets secretStore
	mu      sync.Mutex
}

// Connection is a connection kept on this device, without its secret.
type Connection struct {
	// ID names the connection here, and its secret in the keychain.
	ID string `json:"id"`
	// Service is what it reaches: "ics", "caldav", "google-calendar",
	// "google-drive", "github" or "slack".
	Service string `json:"service"`
	// Name is what the person calls it, as "Work calendar".
	Name string `json:"name"`
	// Account is who it acts as at the service; empty when it does not say.
	Account string `json:"account"`
	// Address is what it is shown by: a feed's host alone, since a feed's
	// whole address is often its secret.
	Address string `json:"address"`
	// Web is the service's web host, for links to it; empty when none.
	Web string `json:"web"`
	// Origins are where its requests may go, as https://example.org.
	Origins []string `json:"origins"`
	// HasSecret says whether the keychain holds a secret for it.
	HasSecret bool `json:"hasSecret"`
}

// connectionServices are the services a connection may reach.
var connectionServices = []string{"ics", "caldav", "google-calendar", "google-drive", "github", "slack"}

func NewConnections(data string, secrets secretStore) *Connections {
	return &Connections{file: filepath.Join(data, "connections.json"), secrets: secrets}
}

// connectionSecretName is where the keychain keeps a connection's secret.
func connectionSecretName(id string) string {
	return "connection " + id
}

// connectionOrigin checks an origin: http or https, with a host, and
// nothing after it.
func connectionOrigin(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" ||
		parsed.User != nil || parsed.Scheme+"://"+parsed.Host != raw {
		return fmt.Errorf("%q is not an origin", raw)
	}
	return nil
}

// List returns the connections kept on this device.
func (c *Connections) List() ([]Connection, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.read()
}

// Save adds a connection, or changes one with its ID, and returns it as
// kept. A new connection gets an ID; its secret comes through SetSecret.
func (c *Connections) Save(connection Connection) (Connection, error) {
	connection.Name = strings.TrimSpace(connection.Name)
	connection.Address = strings.TrimSpace(connection.Address)
	if connection.Name == "" || connection.Address == "" {
		return Connection{}, errors.New("a connection needs a name and an address")
	}
	if len(connection.Name) > 200 {
		return Connection{}, errors.New("that name is too long")
	}
	if !slices.Contains(connectionServices, connection.Service) {
		return Connection{}, fmt.Errorf("%q is not a service", connection.Service)
	}
	if len(connection.Origins) == 0 || len(connection.Origins) > 20 {
		return Connection{}, errors.New("a connection reaches between one and twenty origins")
	}
	for _, origin := range connection.Origins {
		if err := connectionOrigin(origin); err != nil {
			return Connection{}, err
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	list, err := c.read()
	if err != nil {
		return Connection{}, err
	}
	if connection.ID == "" {
		connection.ID = newUUIDv7(time.Now())
		connection.HasSecret = false
		list = append(list, connection)
	} else {
		at := connectionIndex(list, connection.ID)
		if at < 0 {
			return Connection{}, fmt.Errorf("no connection %q is kept here", connection.ID)
		}
		// Whether there is a secret is the keychain's to say, through SetSecret.
		connection.HasSecret = list[at].HasSecret
		list[at] = connection
	}
	return connection, writeJSON(c.file, list)
}

// SetSecret keeps a connection's secret in the keychain; an empty one
// removes it.
func (c *Connections) SetSecret(id string, secret string) error {
	if len(secret) > mygo.MaxSecretSize {
		return errors.New("that secret is too long")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	list, err := c.read()
	if err != nil {
		return err
	}
	at := connectionIndex(list, id)
	if at < 0 {
		return fmt.Errorf("no connection %q is kept here", id)
	}
	if secret == "" {
		if err := c.secrets.Delete(connectionSecretName(id)); err != nil && !errors.Is(err, mygo.ErrSecretNotFound) {
			return err
		}
	} else if err := c.secrets.Set(connectionSecretName(id), []byte(secret)); err != nil {
		return err
	}
	list[at].HasSecret = secret != ""
	return writeJSON(c.file, list)
}

// Secret returns a connection's secret; empty when the keychain has none.
func (c *Connections) Secret(id string) (string, error) {
	if id == "" {
		return "", nil
	}
	secret, err := c.secrets.Get(connectionSecretName(id))
	if errors.Is(err, mygo.ErrSecretNotFound) {
		return "", nil
	}
	return string(secret), err
}

// Remove forgets a connection, and its secret leaves the keychain.
func (c *Connections) Remove(id string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	list, err := c.read()
	if err != nil {
		return err
	}
	if err := c.secrets.Delete(connectionSecretName(id)); err != nil && !errors.Is(err, mygo.ErrSecretNotFound) {
		return err
	}
	next := []Connection{}
	for _, connection := range list {
		if connection.ID != id {
			next = append(next, connection)
		}
	}
	return writeJSON(c.file, next)
}

func connectionIndex(list []Connection, id string) int {
	for at, connection := range list {
		if connection.ID == id {
			return at
		}
	}
	return -1
}

func (c *Connections) read() ([]Connection, error) {
	data, err := os.ReadFile(c.file)
	if errors.Is(err, fs.ErrNotExist) {
		return []Connection{}, nil
	}
	if err != nil {
		return nil, err
	}
	var list []Connection
	if err := json.Unmarshal(data, &list); err != nil {
		// A damaged file is started again; the secrets stay in the keychain.
		return []Connection{}, nil
	}
	if list == nil {
		list = []Connection{}
	}
	for at := range list {
		if list[at].Origins == nil {
			list[at].Origins = []string{}
		}
	}
	return list, nil
}
