# Article Extractor 📰➡️🤖

[License: MIT]

**Live Demo:** [https://vansio3.github.io/ArticleScraper/](https://vansio3.github.io/ArticleScraper/)

A simple, installable Progressive Web App (PWA) to extract clean article text, add a custom prompt prefix, and quickly share it with your favorite AI model (ChatGPT, Claude, Gemini, etc.).

Stop the tedious copy-paste-cleanup-prompt cycle!

## How it Works (The Bridge)

1.  **Share:** Use your device's "Share" function on any web article -> Select "Article Extractor".
2.  **Extract:** The app fetches the URL and extracts *only* the main article content.
3.  **Prefix:** (Optional) Go to Settings (⚙️) to select/create a prompt prefix (e.g., "Summarise this:", "Fact-check:") which gets added *before* the extracted text.
4.  **Forward:** Use the app's "Share" button -> Send the combined prefix + text to your AI app.

## Key Features

*   **Clean Article Extraction:** Uses Readability.js (with fallbacks) to remove clutter.
*   **PWA Installable:** Add to your home screen (Mobile/Desktop) for an app-like experience.
*   **Share Target:** Directly receive URLs from other apps via the share menu.
*   **Customizable Prefixes:** Use quick presets or create/save your own AI prompts.
*   **Simple UI:** Built with Pico.css.
*   **Client-Side:** Runs in your browser (uses `allorigins.win` proxy for fetching).

## Getting Started

### Use the Live App

1.  **Visit:** [https://vansio3.github.io/ArticleScraper/](https://vansio3.github.io/ArticleScraper/)
2.  **(Recommended) Install:** Use your browser's "Add to Home Screen" or "Install App" option.
3.  **Use:**
    *   Share URLs to the app.
    *   Or, open the app, paste a URL/text, and press the extract (→) button.
    *   Manage prefixes in Settings (⚙️).
    *   Copy or Share the result.

### Local Development

1.  Clone: `git clone https://github.com/vansio3/ArticleScraper.git` <!-- Confirm this is the correct repo URL -->
2.  Navigate: `cd ArticleScraper`
3.  Serve Locally: Open `index.html` via a local web server (required for Service Worker functionality). Simple options include Python's `http.server` or the VS Code Live Server extension.

## Technology

*   Vanilla JS (ES6+), HTML5, CSS3
*   [Pico.css](https://picocss.com/)
*   [Readability.js](https://github.com/mozilla/readability)
*   [AllOrigins.win](https://allorigins.win/) Proxy
*   PWA (Manifest, Service Worker)

## Contributing

Issues and Pull Requests are welcome!

## License

Distributed under the MIT License. See `LICENSE` file.

## Acknowledgements

*   Mozilla Readability.js
*   Pico.css
*   AllOrigins.win
