# Nether's directory

`index.json` lists the plugins and themes that Nether's settings offer to
install ([ADR 0065](../docs/adr/0065-the-directory-is-an-index-in-the-repository-of-files-pinned-by-commit-and-hash.md)).
The app reads it from this repository's `main` branch, so an entry shows
once its pull request is merged.

## Adding a plugin

Keep the plugin in a public repository on GitHub, with its `manifest.json`
and `main.js` at the top, as the [plugins guide](https://fzn0x.github.io/nether/plugins/)
describes. Then open a pull request that adds it to `plugins`:

```json
{
  "id": "word-goal",
  "name": "Word goal",
  "description": "Shows how far a note is from its goal.",
  "author": "your-name",
  "repo": "your-name/nether-word-goal",
  "commit": "3f1c0e9d2b8a7c6e5f4d3c2b1a0e9d8c7b6a5f4e",
  "version": "1.0.0",
  "files": {
    "manifest.json": "<SHA-256 of the file, in hexadecimal>",
    "main.js": "<SHA-256 of the file, in hexadecimal>"
  }
}
```

- `id` and `version` are the manifest's.
- `commit` is the full commit the files are read at. A later commit
  reaches no one until its own pull request updates the entry.
- Each hash is of the file's bytes at that commit, as
  `sha256sum manifest.json main.js` prints it.

## Adding a theme

Keep the theme as one CSS file at the top of a public repository, and
add it to `themes`, with no `version`:

```json
{
  "id": "dusk",
  "name": "Dusk",
  "description": "Warm colors for the evening.",
  "author": "your-name",
  "repo": "your-name/nether-dusk",
  "commit": "<full commit>",
  "files": { "dusk.css": "<SHA-256 of the file>" }
}
```

A theme from the directory loads nothing from the web: a `url()` in it
may only be a `data:` URL, so its fonts and images are inside the file.
Nether refuses to install one that loads anything else. It sets Nether's
design tokens, as the [appearance guide](https://fzn0x.github.io/nether/appearance/) lists them.

## What a review checks

- The repository, the commit and the hashes match the files.
- A plugin's code does what its description says, and asks only for the
  permissions it needs. It still runs in Nether's sandbox, off until each
  person turns it on.
- The `id` is not taken, and the entry's text is plain and accurate.
