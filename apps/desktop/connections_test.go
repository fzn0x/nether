package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestConnectionsKeepSecretsInTheKeychainOnly(t *testing.T) {
	data := t.TempDir()
	secrets := memorySecrets{}
	connections := NewConnections(data, secrets)

	empty, err := connections.List()
	if err != nil || len(empty) != 0 {
		t.Fatalf("empty = %+v, %v", empty, err)
	}
	work, err := connections.Save(Connection{
		Service: "ics",
		Name:    " Work ",
		Address: "calendar.example.org",
		Origins: []string{"https://calendar.example.org"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if work.ID == "" || work.Name != "Work" || work.HasSecret {
		t.Fatalf("work = %+v", work)
	}
	feed := `{"address":"https://calendar.example.org/private-abc123/basic.ics"}`
	if err := connections.SetSecret(work.ID, feed); err != nil {
		t.Fatal(err)
	}
	list, err := connections.List()
	if err != nil || len(list) != 1 || !list[0].HasSecret {
		t.Fatalf("list = %+v, %v", list, err)
	}
	secret, err := connections.Secret(work.ID)
	if err != nil || secret != feed {
		t.Fatalf("secret = %q, %v", secret, err)
	}
	// The secret is in the keychain and nowhere in the file.
	file, err := os.ReadFile(filepath.Join(data, "connections.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(file), "private-abc123") {
		t.Fatalf("connections.json holds the secret: %s", file)
	}
	if string(secrets["connection "+work.ID]) != feed {
		t.Fatalf("keychain = %v", secrets)
	}

	// A change keeps the secret, whatever the page says of it.
	work.Name = "Office"
	work.HasSecret = false
	changed, err := connections.Save(work)
	if err != nil || changed.Name != "Office" || !changed.HasSecret {
		t.Fatalf("changed = %+v, %v", changed, err)
	}
	// An empty secret removes it.
	if err := connections.SetSecret(work.ID, ""); err != nil {
		t.Fatal(err)
	}
	if none, err := connections.Secret(work.ID); err != nil || none != "" {
		t.Fatalf("no secret = %q, %v", none, err)
	}

	if err := connections.SetSecret(work.ID, feed); err != nil {
		t.Fatal(err)
	}
	if err := connections.Remove(work.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := secrets["connection "+work.ID]; ok {
		t.Fatalf("the secret stayed in the keychain: %v", secrets)
	}
	if after, err := connections.List(); err != nil || len(after) != 0 {
		t.Fatalf("after = %+v, %v", after, err)
	}
	if none, err := connections.Secret(""); err != nil || none != "" {
		t.Fatalf("no ID = %q, %v", none, err)
	}
}

func TestConnectionsRefuseWhatTheyCannotKeep(t *testing.T) {
	connections := NewConnections(t.TempDir(), memorySecrets{})
	good := Connection{
		Service: "ics",
		Name:    "Work",
		Address: "calendar.example.org",
		Origins: []string{"https://calendar.example.org"},
	}
	for _, bad := range []Connection{
		{Service: "ics", Name: " ", Address: "a", Origins: good.Origins},
		{Service: "ics", Name: "Work", Address: "", Origins: good.Origins},
		{Service: "ics", Name: strings.Repeat("n", 201), Address: "a", Origins: good.Origins},
		{Service: "dropbox", Name: "Work", Address: "a", Origins: good.Origins},
		{Service: "ics", Name: "Work", Address: "a", Origins: nil},
		{Service: "ics", Name: "Work", Address: "a", Origins: []string{"https://example.org/path"}},
		{Service: "ics", Name: "Work", Address: "a", Origins: []string{"ftp://example.org"}},
		{Service: "ics", Name: "Work", Address: "a", Origins: []string{"https://ada@example.org"}},
		{ID: "missing", Service: "ics", Name: "Work", Address: "a", Origins: good.Origins},
	} {
		if _, err := connections.Save(bad); err == nil {
			t.Fatalf("kept %+v", bad)
		}
	}
	if err := connections.SetSecret("missing", "x"); err == nil {
		t.Fatal("kept a secret for no connection")
	}
	if err := connections.SetSecret("missing", strings.Repeat("x", 1<<20)); err == nil {
		t.Fatal("kept a secret too long for the keychain")
	}
}

func TestConnectionsStartAgainFromADamagedFile(t *testing.T) {
	data := t.TempDir()
	if err := os.WriteFile(filepath.Join(data, "connections.json"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	list, err := NewConnections(data, memorySecrets{}).List()
	if err != nil || len(list) != 0 {
		t.Fatalf("list = %+v, %v", list, err)
	}
	if err := os.WriteFile(filepath.Join(data, "connections.json"), []byte(`[{"id":"a"}]`), 0o600); err != nil {
		t.Fatal(err)
	}
	list, err = NewConnections(data, memorySecrets{}).List()
	if err != nil || len(list) != 1 || list[0].Origins == nil {
		t.Fatalf("list = %+v, %v", list, err)
	}
}
