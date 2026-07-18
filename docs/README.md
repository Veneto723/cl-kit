# docs

Drop media referenced by the top-level `README.md` here.

## Recording the account picker (`picker.gif`)

1. Launch a session with 2+ accounts: `arc`
2. Start a screen recorder aimed at the terminal (e.g. [ScreenToGif](https://www.screentogif.com/), or Windows **Xbox Game Bar** → record, then convert to GIF).
3. Type `/arc-switch`, move with ↑/↓, press Enter (or Esc to cancel).
4. Save the result as `docs/picker.gif`, then in the root `README.md` uncomment:

   ```markdown
   ![account picker](docs/picker.gif)
   ```

   and remove the text preview block above it.

Keep it short (a few seconds) and reasonably sized (< ~2 MB) so it loads fast on
the repo page.
