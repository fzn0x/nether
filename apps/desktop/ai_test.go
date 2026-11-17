package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAIKeepsKeysInTheKeychainOnly(t *testing.T) {
	data := t.TempDir()
	secrets := memorySecrets{}
	ai := NewAI(data, secrets)

	empty, err := ai.List()
	if err != nil || len(empty.Providers) != 0 || empty.Default != "" {
		t.Fatalf("empty = %+v, %v", empty, err)
	}
	ollama, err := ai.Save(AIProvider{Name: " Ollama ", Kind: "openai", URL: "http://localhost:11434/v1/", Model: "llama3.2"})
	if err != nil {
		t.Fatal(err)
	}
	if ollama.ID == "" || ollama.Name != "Ollama" || ollama.URL != "http://localhost:11434/v1" || ollama.HasKey {
		t.Fatalf("ollama = %+v", ollama)
	}
	claude, err := ai.Save(AIProvider{Name: "Claude", Kind: "anthropic", URL: "https://api.anthropic.com", Model: "claude-sonnet-5-5"})
	if err != nil {
		t.Fatal(err)
	}
	if err := ai.SetKey(claude.ID, "sk-ant-secret"); err != nil {
		t.Fatal(err)
	}

	settings, err := ai.List()
	if err != nil {
		t.Fatal(err)
	}
	// The first provider set up is the default.
	if settings.Default != ollama.ID || len(settings.Providers) != 2 || !settings.Providers[1].HasKey || settings.Providers[0].HasKey {
		t.Fatalf("settings = %+v", settings)
	}
	key, err := ai.Key(claude.ID)
	if err != nil || key != "sk-ant-secret" {
		t.Fatalf("key = %q, %v", key, err)
	}
	none, err := ai.Key(ollama.ID)
	if err != nil || none != "" {
		t.Fatalf("no key = %q, %v", none, err)
	}
	// The key is in the keychain and nowhere in the file.
	file, err := os.ReadFile(filepath.Join(data, "ai.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(file), "sk-ant-secret") {
		t.Fatalf("ai.json holds the key: %s", file)
	}
	if string(secrets["ai "+claude.ID]) != "sk-ant-secret" {
		t.Fatalf("keychain = %v", secrets)
	}

	// Changing a provider keeps its key; an empty key removes it.
	claude.Model = "claude-opus-5-5"
	claude.HasKey = false
	changed, err := ai.Save(claude)
	if err != nil || !changed.HasKey || changed.Model != "claude-opus-5-5" {
		t.Fatalf("changed = %+v, %v", changed, err)
	}
	if err := ai.SetKey(claude.ID, ""); err != nil {
		t.Fatal(err)
	}
	if _, found := secrets["ai "+claude.ID]; found {
		t.Fatal("the key stayed in the keychain")
	}

	// The default moves, and removing it makes the first left the default.
	if err := ai.SetDefault(claude.ID); err != nil {
		t.Fatal(err)
	}
	if err := ai.SetKey(claude.ID, "again"); err != nil {
		t.Fatal(err)
	}
	if err := ai.Remove(claude.ID); err != nil {
		t.Fatal(err)
	}
	if _, found := secrets["ai "+claude.ID]; found {
		t.Fatal("a removed provider's key stayed in the keychain")
	}
	left, err := ai.List()
	if err != nil || len(left.Providers) != 1 || left.Default != ollama.ID {
		t.Fatalf("left = %+v, %v", left, err)
	}
	if err := ai.Remove(ollama.ID); err != nil {
		t.Fatal(err)
	}
	gone, err := ai.List()
	if err != nil || len(gone.Providers) != 0 || gone.Default != "" {
		t.Fatalf("gone = %+v, %v", gone, err)
	}
}

func TestAIRefusesWhatIsNotAProvider(t *testing.T) {
	ai := NewAI(t.TempDir(), memorySecrets{})
	bad := []AIProvider{
		{Name: "", Kind: "openai", URL: "https://api.openai.com/v1", Model: "m"},
		{Name: "n", Kind: "openai", URL: "https://api.openai.com/v1", Model: " "},
		{Name: "n", Kind: "gemini", URL: "https://example.org", Model: "m"},
		{Name: "n", Kind: "openai", URL: "ftp://example.org", Model: "m"},
		{Name: "n", Kind: "openai", URL: "https://user:pw@example.org", Model: "m"},
		{Name: "n", Kind: "openai", URL: "https://example.org/?key=1", Model: "m"},
		{Name: "n", Kind: "openai", URL: "https://example.org/#x", Model: "m"},
		{Name: "n", Kind: "openai", URL: "localhost:11434", Model: "m"},
		{ID: "missing", Name: "n", Kind: "openai", URL: "https://example.org", Model: "m"},
	}
	for _, provider := range bad {
		if _, err := ai.Save(provider); err == nil {
			t.Errorf("saved %+v", provider)
		}
	}
	if err := ai.SetKey("missing", "k"); err == nil {
		t.Error("kept a key for no provider")
	}
	if err := ai.SetKey("missing", strings.Repeat("k", 3000)); err == nil {
		t.Error("kept a key too long for the keychain")
	}
	if err := ai.SetDefault("missing"); err == nil {
		t.Error("made a missing provider the default")
	}
	if key, err := ai.Key(""); err != nil || key != "" {
		t.Errorf("key of nothing = %q, %v", key, err)
	}
}

func TestAIStartsAgainFromADamagedFile(t *testing.T) {
	data := t.TempDir()
	if err := os.WriteFile(filepath.Join(data, "ai.json"), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	settings, err := NewAI(data, memorySecrets{}).List()
	if err != nil || len(settings.Providers) != 0 {
		t.Fatalf("settings = %+v, %v", settings, err)
	}
}
