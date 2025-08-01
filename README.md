# Trello to GitHub Import Tool

A CLI utility to import a Trello project into GitHub Issues and Projects.

## Features

- **Imports Trello Boards**: Transfer cards, lists, and board structure from Trello to GitHub.
- **User and Label Mapping**: Map Trello users and labels to GitHub equivalents via a TOML file.
- **Flexible Trello Input**: Import directly from a Trello export JSON file or a live board URL.
- **GitHub Auth**: Uses your GitHub personal access token for authentication.

![A screenshot of the tool in use](./.github/assets/screenshot.png)

## Installation

```bash
npm install -g @piemot/trello-to-github
# or use via npx
npx @piemot/trello-to-github ...
```

## Usage

```bash
trello-to-github [options]
```

### Options

- `--github-token <token>`  
  Your GitHub Personal Access Token. **Required** for making changes on GitHub.

- `-m, --map <file.toml>`  
  Path to a TOML file mapping Trello users and labels to GitHub.

- `--dry-run`  
  Preview the migration, showing what would be transferred without making changes.

- `--keep-closed`  
  Also transfer cards that have been closed (archived) on Trello.

- `--trello-export <file.json>`  
  Path to a Trello export JSON file.  
  You can get this by downloading:  
  `https://trello.com/b/<board-id>.json`

- `--trello-url <url>`  
  The URL to your Trello board.  
  _Cannot be used together with `--trello-export`._

- `-h, --help`  
  Show help information.

- `-V, --version`  
  Show version information.

## Example

```bash
trello-to-github \
  --github-token YOUR_TOKEN_HERE \
  --trello-export board.json \
  --map mapping.toml \
  --dry-run
```

## Mapping File

The mapping file is a TOML file that lets you specify how Trello users and labels map to GitHub users and labels.

```toml
project = 5

[repo]
# The GitHub username of the repo owner
owner = "piemot"
# If the owner is an org, use:
# owner = { type = "organization", login = "piemot" }

# The name of the repository
repo = "sample"

[[users]]
trello = "piemot"
github = "piemot"

[[labels]]
trello = "RFC"
github = "Request For Comments"
```

## How to Get Your Trello Export

1. Go to your Trello board.
2. Visit: `https://trello.com/b/<board-id>.json`
3. Save the file locally and use it with `--trello-export`.

## Notes

- You must have a [GitHub Personal Access Token](https://github.com/settings/tokens) with `repo` permissions.
- Either `--trello-export` or `--trello-url` must be provided, but not both.

## Contributing

PRs welcome! Please open issues for feature requests or bug reports.

## License

MIT

---

_This project is not affiliated with Trello or GitHub._
