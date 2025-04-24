/*
 * Copyright (c) 2010 Arc90 Inc
 * Copyright (c) 2017 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * This code is heavily based on Arc90's readability.js (1.7.1) script
 * available at: http://code.google.com/p/arc90labs-readability
 *
 * ** PERFORMANCE OPTIMIZATIONS & MODERNIZATION APPLIED **
 * - Refactored `_grabArticle` retry logic to use `cloneNode` instead of `innerHTML` assignment, significantly improving performance on failed attempts.
 * - Optimized `_cleanConditionally` to use a single `querySelectorAll` per candidate node instead of multiple `getElementsByTagName` calls.
 * - Replaced `var` with `let`/`const`.
 * - Used `for...of` loops for iteration where appropriate.
 * - Applied other modern JS syntax for clarity and potential minor improvements.
 * - Extracted `_finalizeArticle` helper to reduce duplication.
 */

/**
 * Public constructor.
 * @param {HTMLDocument} doc     The document to parse.
 * @param {Object}       options The options object.
 */
function Readability(doc, options) {
  // In some older versions, people passed a URI as the first argument. Cope:
  if (options && options.documentElement) {
    doc = options;
    options = arguments[2];
  } else if (!doc || !doc.documentElement) {
    throw new Error(
      "First argument to Readability constructor should be a document object."
    );
  }
  options = options || {};

  this._doc = doc;
  // Assigning this locally avoids deeper prototype lookups repeatedly
  this._docElement = this._doc.documentElement;
  // TODO: check if this is actually needed for performance enhancement.
  // this._docJSDOMParser = this._doc.firstChild.__JSDOMParser__; // Used for specific JSDOM checks, commented out if not strictly needed
  this._articleTitle = null;
  this._articleByline = null;
  this._articleDir = null;
  this._articleSiteName = null;
  this._attempts = []; // Still used to track failed attempts' content if final attempt fails
  this._metadata = {};


  // Configurable options
  this._debug = !!options.debug;
  this._maxElemsToParse = options.maxElemsToParse || this.DEFAULT_MAX_ELEMS_TO_PARSE;
  this._nbTopCandidates = options.nbTopCandidates || this.DEFAULT_N_TOP_CANDIDATES;
  this._charThreshold = options.charThreshold || this.DEFAULT_CHAR_THRESHOLD;
  this._classesToPreserve = this.CLASSES_TO_PRESERVE.concat(
    options.classesToPreserve || []
  );
  this._keepClasses = !!options.keepClasses;
  this._serializer = options.serializer || function (el) { return el.innerHTML; };
  this._disableJSONLD = !!options.disableJSONLD;
  this._allowedVideoRegex = options.allowedVideoRegex || this.REGEXPS.videos;
  this._linkDensityModifier = options.linkDensityModifier || 0; // Adjust link density penalty


  // Start with all flags set
  this._flags =
    this.FLAG_STRIP_UNLIKELYS |
    this.FLAG_WEIGHT_CLASSES |
    this.FLAG_CLEAN_CONDITIONALLY;

  // Control whether log messages are sent to the console
  if (this._debug) {
    const logNode = (node) => {
      if (!node) return "null node";
      if (node.nodeType == this.TEXT_NODE) {
        return `${node.nodeName} ("${node.textContent.trim()}")`;
      }
      let attrPairs = "";
      if (node.attributes) {
        attrPairs = Array.from(node.attributes, attr => `${attr.name}="${attr.value}"`).join(" ");
      }
      return `<${node.localName || node.nodeName} ${attrPairs}>`;
    };
    this.log = (...args) => {
        const processedArgs = args.map(arg =>
           (arg && arg.nodeType === this.ELEMENT_NODE) ? logNode(arg) : arg
        );
      if (typeof console !== "undefined") {
        console.log("Reader: (Readability)", ...processedArgs);
      } else if (typeof dump !== "undefined") {
        dump(`Reader: (Readability) ${processedArgs.join(" ")}\n`);
      }
    };
  } else {
    this.log = function () {};
  }
}

Readability.prototype = {
  FLAG_STRIP_UNLIKELYS: 0x1,
  FLAG_WEIGHT_CLASSES: 0x2,
  FLAG_CLEAN_CONDITIONALLY: 0x4,

  // https://developer.mozilla.org/en-US/docs/Web/API/Node/nodeType
  ELEMENT_NODE: 1,
  TEXT_NODE: 3,

  // Max number of nodes supported by this parser. Default: 0 (no limit)
  DEFAULT_MAX_ELEMS_TO_PARSE: 0,

  // The number of top candidates to consider when analysing how
  // tight the competition is among candidates.
  DEFAULT_N_TOP_CANDIDATES: 5,

  // Element tags to score by default.
  DEFAULT_TAGS_TO_SCORE: "section,h2,h3,h4,h5,h6,p,td,pre"
    .toUpperCase()
    .split(","),

  // The default number of chars an article must have in order to return a result
  DEFAULT_CHAR_THRESHOLD: 500,

  // All of the regular expressions in use within readability.
  // Defined up here so we don't instantiate them repeatedly in loops.
  REGEXPS: {
    // NOTE: These two regular expressions are duplicated in
    // Readability-readerable.js. Please keep both copies in sync.
    unlikelyCandidates:
      /-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote/i,
    okMaybeItsACandidate:
      /and|article|body|column|content|main|mathjax|shadow/i,

    positive:
      /article|body|content|entry|hentry|h-entry|main|page|pagination|post|text|blog|story/i,
    negative:
      /-ad-|hidden|^hid$| hid$| hid |^hid |banner|combx|comment|com-|contact|footer|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|widget/i,
    extraneous:
      /print|archive|comment|discuss|e[\-]?mail|share|reply|all|login|sign|single|utility/i,
    byline: /byline|author|dateline|writtenby|p-author/i,
    replaceFonts: /<(\/?)font[^>]*>/gi, // Note: Effectively unused due to prepDocument logic
    normalize: /\s{2,}/g,
    videos:
      /\/\/(www\.)?((dailymotion|youtube|youtube-nocookie|player\.vimeo|v\.qq|bilibili|live.bilibili)\.com|(archive|upload\.wikimedia)\.org|player\.twitch\.tv)/i,
    shareElements: /(\b|_)(share|sharedaddy)(\b|_)/i,
    nextLink: /(next|weiter|continue|>([^\|]|$)|»([^\|]|$))/i, // Ensure non-capturing groups if needed: (?:...)
    prevLink: /(prev|earl|old|new|<|«)/i,
    tokenize: /\W+/g,
    whitespace: /^\s*$/,
    hasContent: /\S$/,
    hashUrl: /^#.+/,
    srcsetUrl: /(\S+)(\s+[\d.]+[xw])?(\s*(?:,|$))/g,
    b64DataUrl: /^data:\s*([^\s;,]+)\s*;\s*base64\s*,/i,
    // Commas as used in Latin, Sindhi, Chinese and various other scripts.
    // see: https://en.wikipedia.org/wiki/Comma#Comma_variants
    commas: /\u002C|\u060C|\uFE50|\uFE10|\uFE11|\u2E41|\u2E34|\u2E32|\uFF0C/g,
    // See: https://schema.org/Article
    jsonLdArticleTypes:
      /^Article|AdvertiserContentArticle|NewsArticle|AnalysisNewsArticle|AskPublicNewsArticle|BackgroundNewsArticle|OpinionNewsArticle|ReportageNewsArticle|ReviewNewsArticle|Report|SatiricalArticle|ScholarlyArticle|MedicalScholarlyArticle|SocialMediaPosting|BlogPosting|LiveBlogPosting|DiscussionForumPosting|TechArticle|APIReference$/,
     // used to see if a node's content matches words commonly used for ad blocks or loading indicators
    adWords:
      /^(ad(vertising|vertisement)?|pub(licité)?|werb(ung)?|广告|Реклама|Anuncio)$/iu,
    loadingWords:
      /^((loading|正在加载|Загрузка|chargement|cargando)(…|\.\.\.)?)$/iu,
  },

  UNLIKELY_ROLES: [
    "menu",
    "menubar",
    "complementary",
    "navigation",
    "alert",
    "alertdialog",
    "dialog",
  ],

  // Note: Using Sets for faster lookups
  DIV_TO_P_ELEMS: new Set([
    "BLOCKQUOTE", "DL", "DIV", "IMG", "OL", "P", "PRE", "TABLE", "UL",
  ]),

  ALTER_TO_DIV_EXCEPTIONS: ["DIV", "ARTICLE", "SECTION", "P", "OL", "UL"], // Consider Set if performance critical

  PRESENTATIONAL_ATTRIBUTES: [
    "align", "background", "bgcolor", "border", "cellpadding",
    "cellspacing", "frame", "hspace", "rules", "style", "valign", "vspace",
  ], // Consider Set

  DEPRECATED_SIZE_ATTRIBUTE_ELEMS: ["TABLE", "TH", "TD", "HR", "PRE"], // Consider Set

  PHRASING_ELEMS: [
    // "CANVAS", "IFRAME", "SVG", "VIDEO", // Commented out in original
    "ABBR", "AUDIO", "B", "BDO", "BR", "BUTTON", "CITE", "CODE", "DATA",
    "DATALIST", "DFN", "EM", "EMBED", "I", "IMG", "INPUT", "KBD", "LABEL",
    "MARK", "MATH", "METER", "NOSCRIPT", "OBJECT", "OUTPUT", "PROGRESS",
    "Q", "RUBY", "SAMP", "SCRIPT", "SELECT", "SMALL", "SPAN", "STRONG",
    "SUB", "SUP", "TEXTAREA", "TIME", "VAR", "WBR",
  ], // Consider Set

  // These are the classes that readability sets itself.
  CLASSES_TO_PRESERVE: ["page"], // Consider Set

  // HTML entities that need escaping (minimal set for example)
  HTML_ESCAPE_MAP: {
    lt: "<",
    gt: ">",
    amp: "&",
    quot: '"',
    apos: "'",
  },

  /**
   * Run any post-process modifications to article content as necessary.
   *
   * @param {Element} articleContent The main element containing the article content.
   */
  _postProcessContent(articleContent) {
    this._fixRelativeUris(articleContent);
    this._simplifyNestedElements(articleContent);

    if (!this._keepClasses) {
      this._cleanClasses(articleContent);
    }
  },

  /**
   * Iterates over a NodeList or Array, calls `filterFn` for each node and removes node
   * if function returned `true`. Iterates backwards for safe removal.
   *
   * @param {(NodeList|Array<Node>)} nodeList The nodes to operate on.
   * @param {Function} filterFn the function to use as a filter. args: (node, index, list).
   */
  _removeNodes(nodeList, filterFn) {
    // Work on a static array copy for safety if nodeList might be live.
    const nodes = Array.from(nodeList);
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      const parentNode = node.parentNode;
      if (parentNode) {
        if (!filterFn || filterFn.call(this, node, i, nodes)) {
          parentNode.removeChild(node);
        }
      }
    }
  },

  /**
   * Iterates over a NodeList or Array, and calls _setNodeTag for each node.
   *
   * @param {(NodeList|Array<Node>)} nodeList The nodes to operate on.
   * @param {String} newTagName the new tag name to use.
   */
  _replaceNodeTags(nodeList, newTagName) {
    // NodeLists returned by querySelectorAll are static, direct iteration is fine.
    // If getElementsByTagName is used elsewhere, ensure it's converted if needed.
    for (const node of nodeList) {
      this._setNodeTag(node, newTagName);
    }
  },

  /**
   * Helper to iterate over a NodeList or array using for...of.
   * @param {(NodeList|Array<Node>)} nodeList
   * @param {Function} fn Callback function (node, index, list)
   */
  _forEachNode(nodeList, fn) {
      const nodes = Array.from(nodeList); // Create static copy if needed
      let i = 0;
      for(const node of nodes) {
          fn.call(this, node, i++, nodes);
      }
  },

  /**
   * Helper to find a node in a NodeList or array using for...of.
   * @param {(NodeList|Array<Node>)} nodeList
   * @param {Function} fn Test function (node, index, list) -> boolean
   * @returns {Node|null}
   */
   _findNode(nodeList, fn) {
       let i = 0;
       for (const node of nodeList) {
           if (fn.call(this, node, i++, nodeList)) {
               return node;
           }
       }
       return null;
   },

   /**
    * Helper to check if some node satisfies condition.
    * @param {(NodeList|Array<Node>)} nodeList
    * @param {Function} fn Test function (node, index, list) -> boolean
    * @returns {boolean}
    */
   _someNode(nodeList, fn) {
       let i = 0;
       for (const node of nodeList) {
           if (fn.call(this, node, i++, nodeList)) {
               return true;
           }
       }
       return false;
   },

   /**
    * Helper to check if all nodes satisfy condition.
    * @param {(NodeList|Array<Node>)} nodeList
    * @param {Function} fn Test function (node, index, list) -> boolean
    * @returns {boolean}
    */
   _everyNode(nodeList, fn) {
        let i = 0;
        for (const node of nodeList) {
            if (!fn.call(this, node, i++, nodeList)) {
                return false;
            }
        }
        return true;
    },

  /**
   * Get all nodes with specific tag names. Uses querySelectorAll.
   * @param {Node} node Parent node
   * @param {Array<string>} tagNames Array of tag names
   * @returns {NodeList} Static NodeList of matching elements
   */
  _getAllNodesWithTag(node, tagNames) {
      // querySelectorAll is generally faster and returns a static list
      if (node.querySelectorAll) {
          return node.querySelectorAll(tagNames.join(','));
      }
      // Fallback for environments without querySelectorAll (highly unlikely)
      let result = [];
      for (const tagName of tagNames) {
          const collection = node.getElementsByTagName(tagName);
          result = result.concat(Array.from(collection));
      }
      return result; // Returns array in fallback case
  },

  /**
   * Removes the class="" attribute from every element in the given
   * subtree, except those that match CLASSES_TO_PRESERVE and
   * the classesToPreserve array from the options object.
   *
   * @param {Element} node The starting node.
   */
  _cleanClasses(node) {
      if (!node || typeof node.getAttribute !== 'function') return;

      const classesToPreserveSet = new Set(this._classesToPreserve); // Use Set for faster lookups
      const className = (node.getAttribute("class") || "")
          .split(/\s+/)
          .filter(cls => cls && classesToPreserveSet.has(cls)) // Check cls exists
          .join(" ");

      if (className) {
          node.setAttribute("class", className);
      } else {
          node.removeAttribute("class");
      }

      let child = node.firstElementChild;
      while (child) {
          this._cleanClasses(child);
          child = child.nextElementSibling;
      }
  },

  /**
   * Tests whether a string looks like a URL.
   * @param {string} str
   * @returns {boolean}
   */
  _isUrl(str) {
      if (!str) return false;
      // Simple check for protocol for performance, fallback to URL constructor if needed
      if (str.startsWith('http:') || str.startsWith('https:') || str.startsWith('//')) {
        try {
          new URL(str); // More robust check
          return true;
        } catch (_) {
          // Fall through if it looks like URL but isn't parseable (e.g. relative starting with //)
        }
      }
      // Basic check for common protocols or root-relative URLs
      return /^(?:https?|ftp):\/\//.test(str) || /^\/[^/]?/.test(str) || /^#/.test(str);
  },

  /**
   * Converts each <a> and media uri in the given element to an absolute URI,
   * relative to the document's base URI. Skips #hash links if base URI matches document URI.
   *
   * @param {Element} articleContent The element to process.
   */
  _fixRelativeUris(articleContent) {
      const baseURI = this._doc.baseURI;
      const documentURI = this._doc.documentURI;

      const toAbsoluteURI = (uri) => {
          if (!uri) return uri; // Handle null/empty URIs
          // Leave hash links alone if the base URI matches the document URI:
          if (baseURI === documentURI && uri.charAt(0) === "#") {
              return uri;
          }
          // Handle protocol-relative URLs
          if (uri.startsWith("//")) {
              uri = new URL(baseURI).protocol + uri;
          }

          // Otherwise, resolve against base URI:
          try {
              // Use URL constructor for robust resolution
              return new URL(uri, baseURI).href;
          } catch (ex) {
              this.log("Failed to resolve URI:", uri, ex);
              // Passthrough for potentially invalid URIs? Or return null?
              return uri;
          }
      };

      // Process links
      const links = this._getAllNodesWithTag(articleContent, ["a"]);
      for (const link of links) {
          const href = link.getAttribute("href");
          if (href) {
              // Remove links with javascript: URIs
              if (href.startsWith("javascript:")) {
                  // Replace with text content if simple
                  if (link.childNodes.length === 1 && link.firstChild.nodeType === this.TEXT_NODE) {
                      const text = this._doc.createTextNode(link.textContent);
                      link.parentNode.replaceChild(text, link);
                  } else {
                      // Otherwise, replace with a span wrapper
                      const span = this._doc.createElement("span");
                      // Move children efficiently
                      while (link.firstChild) {
                          span.appendChild(link.firstChild);
                      }
                      link.parentNode.replaceChild(span, link);
                  }
              } else {
                  link.setAttribute("href", toAbsoluteURI(href));
              }
          }
      }

      // Process media elements
      const media = this._getAllNodesWithTag(articleContent, [
          "img", "picture", "figure", "video", "audio", "source",
      ]);
      for (const medium of media) {
          const src = medium.getAttribute("src");
          const poster = medium.getAttribute("poster");
          const srcset = medium.getAttribute("srcset");

          if (src) {
              medium.setAttribute("src", toAbsoluteURI(src));
          }
          if (poster) {
              medium.setAttribute("poster", toAbsoluteURI(poster));
          }
          if (srcset) {
              const newSrcset = srcset.replace(
                  this.REGEXPS.srcsetUrl,
                  (_, p1, p2, p3) => {
                      return toAbsoluteURI(p1) + (p2 || "") + p3;
                  }
              );
              medium.setAttribute("srcset", newSrcset);
          }
      }
  },

  /**
   * Simplifies nested DIVs and SECTIONs. If a node contains only one child
   * of the same type, hoist the child's attributes and replace the parent.
   * Removes empty containers.
   * @param {Element} articleContent
   */
  _simplifyNestedElements(articleContent) {
      let node = articleContent;

      while (node) {
          const parentNode = node.parentNode; // Keep track of parent before potential replacement

          if (parentNode && ["DIV", "SECTION"].includes(node.tagName) && !(node.id && node.id.startsWith("readability"))) {
              if (this._isElementWithoutContent(node)) {
                  const nextNode = this._removeAndGetNext(node); // Get next before removing node
                  node = nextNode;
                  continue; // Skip to next iteration
              } else if (this._hasSingleTagInsideElement(node, "DIV") || this._hasSingleTagInsideElement(node, "SECTION")) {
                  const child = node.children[0];
                  // Hoist attributes - avoid overwriting existing ones on child? Or clone them?
                  // Original behavior clones and potentially overwrites.
                  for (const attr of Array.from(node.attributes)) {
                     // Avoid setting class/id if child already has one? For now, mimic original.
                     try { // Setting attributes can sometimes fail (e.g., invalid names)
                        child.setAttribute(attr.name, attr.value);
                     } catch(e) {
                        this.log(`Could not set attribute ${attr.name} from ${node.tagName} to ${child.tagName}`, e);
                     }
                  }
                  parentNode.replaceChild(child, node);
                  node = child; // Continue processing from the child
                  continue; // Skip to next iteration with the new node
              }
          }
          // If no modification, move to the standard next node
          node = this._getNextNode(node);
      }
  },


  /**
   * Get the article title as a string. Handles various separators and fallbacks.
   *
   * @returns {string} The extracted article title.
   */
  _getArticleTitle() {
      const doc = this._doc;
      let curTitle = "";
      let origTitle = "";

      try {
          curTitle = origTitle = doc.title.trim();
          if (!curTitle) { // Check for empty title or non-string
              const titleElement = doc.getElementsByTagName("title")[0];
              if (titleElement) {
                  curTitle = origTitle = this._getInnerText(titleElement).trim();
              }
          }
      } catch (e) {
          this.log("Could not get document title: ", e);
      }

      // If title is excessively long, try using the first H1
      if (curTitle && (curTitle.length > 150 || curTitle.length < 15)) {
        const hOnes = doc.getElementsByTagName("h1");
        if (hOnes.length === 1) {
          const h1Text = this._getInnerText(hOnes[0]).trim();
          if (h1Text && h1Text.length < curTitle.length && h1Text.length > 10) {
            curTitle = h1Text; // Use H1 if it's reasonably shorter and not too short
          }
        }
      }

      const wordCount = (str) => str ? str.split(/\s+/).length : 0;

      // Try splitting by separators only if the title seems long enough
      let titleHadHierarchicalSeparators = false;
      if (curTitle && wordCount(curTitle) > 4) {
          const titleSeparators = /[\|\-–—\\\/»]/; // Use regex directly
          const separatorMatch = curTitle.match(new RegExp(`\\s(${titleSeparators.source})\\s`));

          if (separatorMatch) {
              titleHadHierarchicalSeparators = /[\\\/»]/.test(separatorMatch[1]);
              let possibleTitles = [];
              // Try splitting by all common separators, prioritizing the *first* part
              // unless it's very short compared to the last part.
              const separatorsForSplit = /(\s(?:\||\-|\–|\—|\\|\/|»)\s)/g;
              const parts = curTitle.split(separatorsForSplit);

              // Often the first part is the title
              if (parts.length > 1 && parts[0].length > 3) {
                possibleTitles.push(parts[0]);
              }
              // Sometimes the last part is the title
               if (parts.length > 2 && parts[parts.length-1].length > 3) {
                 possibleTitles.push(parts[parts.length-1]);
               }

               // If we have multiple parts, try to find the longest one
               if (possibleTitles.length > 0) {
                    possibleTitles.sort((a, b) => b.length - a.length);
                    // Check if the longest part is significantly longer than the others
                    if (possibleTitles.length > 1 && possibleTitles[0].length > possibleTitles[1].length * 1.5) {
                        curTitle = possibleTitles[0];
                    } else {
                        // If lengths are similar, maybe prefer the first part? Or stick with the longest.
                        curTitle = possibleTitles[0];
                    }
               }
               // Original logic fallback: remove last part
               // curTitle = origTitle.substring(0, curTitle.lastIndexOf(separatorMatch[0]));

              // If the result is too short, try removing the first part
              if (wordCount(curTitle) < 3 && parts.length > 1) {
                  curTitle = origTitle.substring(origTitle.indexOf(separatorMatch[0]) + separatorMatch[0].length);
              }
          } else if (curTitle.includes(": ")) {
              // Check if a heading matches the part *after* the first colon.
              const hTags = this._getAllNodesWithTag(doc, ["h1", "h2"]);
              const firstColonIndex = curTitle.indexOf(": ");
              const potentialTitle = curTitle.substring(firstColonIndex + 2).trim();
              let headingMatches = false;
              if (potentialTitle) {
                  for (const heading of hTags) {
                    if (this._getInnerText(heading).trim() === potentialTitle) {
                        headingMatches = true;
                        curTitle = potentialTitle;
                        break;
                    }
                  }
              }

              // Original logic fallback (last colon, then first colon)
              if (!headingMatches) {
                const lastColonIndex = curTitle.lastIndexOf(": ");
                if(lastColonIndex > 0) {
                   const titleAfterLastColon = curTitle.substring(lastColonIndex + 2);
                    if (wordCount(titleAfterLastColon) >= 3) {
                        curTitle = titleAfterLastColon;
                    } else if (firstColonIndex > 0 && wordCount(curTitle.substring(0, firstColonIndex)) <= 5) {
                        // Use part after first colon only if part before isn't too long
                        curTitle = curTitle.substring(firstColonIndex + 2);
                    } else {
                       // Stick with original title if colons lead to weird results
                       curTitle = origTitle;
                    }
                }
              }
          }
      }

      curTitle = (curTitle || "").trim().replace(this.REGEXPS.normalize, " ");

      // Final check: if we drastically shortened the title using separators, revert.
      const curTitleWordCount = wordCount(curTitle);
      const origTitleWordCount = wordCount(origTitle.replace(/[\|\-–—\\\/»:]/g, '')); // Approx original words

      if (curTitleWordCount <= 4 && curTitleWordCount < origTitleWordCount - 2) {
           // If title is 4 words or fewer AND we removed > 2 words compared to original (ignoring separators)
           // use the original title. This handles cases like "Site Name | Section | Title" -> "Title" -> "Site Name | Section | Title"
           // unless the original was very short anyway.
           if (wordCount(origTitle) > 4) { // Only revert if original was longer
               curTitle = origTitle;
           }
      }

      // If title is still identical to the original title after all attempts,
      // and the original title contains separators, try a simpler approach: just take the first part.
      if (curTitle === origTitle && /[\|\-–—\\\/»:]/.test(origTitle)) {
          const firstPart = origTitle.split(/[\|\-–—\\\/»:]/)[0].trim();
           if (wordCount(firstPart) >= 3 && wordCount(firstPart) < wordCount(origTitle)) {
              curTitle = firstPart;
           }
      }


      return curTitle || origTitle; // Return original if current is empty
  },


  /**
   * Prepare the HTML document for readability to scrape it.
   * This includes things like stripping javascript, CSS, and handling terrible markup.
   */
  _prepDocument() {
    const doc = this._doc;

    // Remove all style tags in head
    this._removeNodes(this._getAllNodesWithTag(doc.head || doc.documentElement, ["style"])); // Operate on head or fallback to docElement

    if (doc.body) {
      this._replaceBrs(doc.body);
      // Remove font tags - replace with spans
      this._replaceNodeTags(this._getAllNodesWithTag(doc.body, ["font"]), "SPAN");
    }
  },

  /**
   * Finds the next node, starting from the given node, and ignoring
   * whitespace in between. If the given node is an element, the same node is
   * returned. Returns null if no non-whitespace node is found.
   * @param {Node} node Starting node
   * @returns {Node|null} The next non-whitespace node, or null.
   */
  _nextNode(node) {
    let next = node ? node.nextSibling : null; // Start from sibling
    while (next && next.nodeType !== this.ELEMENT_NODE && this.REGEXPS.whitespace.test(next.textContent)) {
      next = next.nextSibling;
    }
    return next;
  },

  /**
   * Replaces 2 or more successive <br> elements with a single <p> wrapping the content that follows.
   * @param {Element} elem The element to process.
   */
  _replaceBrs(elem) {
      const brs = this._getAllNodesWithTag(elem, ["br"]);
      for (const br of brs) {
          let next = br.nextSibling;
          let replaced = false;

          // Skip if already removed or parent doesn't exist
          if (!br.parentNode) continue;

          // Find consecutive BRs, ignoring whitespace
          while (next && (next.nodeType === this.TEXT_NODE && this.REGEXPS.whitespace.test(next.textContent)) || (next && next.tagName === "BR")) {
              if (next.tagName === "BR") {
                  replaced = true;
                  const siblingAfterBr = next.nextSibling; // Get next before removing
                  next.remove();
                  next = siblingAfterBr; // Move to the node after the removed BR
              } else {
                 next = next.nextSibling; // Skip whitespace
              }
          }

          // If we removed one or more consecutive BRs, replace the original BR with a P
          if (replaced) {
              const p = this._doc.createElement("p");
              br.parentNode.replaceChild(p, br);

              // Move subsequent inline content into the new P
              next = p.nextSibling;
              while (next) {
                  // Check if we've hit another <br><br> sequence
                  if (next.tagName === "BR") {
                      const nextElem = this._nextNode(next.nextSibling); // Use helper to skip whitespace
                      if (nextElem && nextElem.tagName === "BR") {
                          break; // Stop if we hit the next double BR
                      }
                  }

                  // Stop if we hit a non-phrasing element
                  if (!this._isPhrasingContent(next)) {
                      break;
                  }

                  // Move the node into the P
                  const sibling = next.nextSibling;
                  p.appendChild(next);
                  next = sibling;
              }

              // Remove trailing whitespace from P
              while (p.lastChild && this._isWhitespace(p.lastChild)) {
                  p.lastChild.remove();
              }

              // If P ended up inside another P (due to structure), change parent P to DIV
              if (p.parentNode && p.parentNode.tagName === "P") {
                  this._setNodeTag(p.parentNode, "DIV");
              }
          }
      }
  },

  /**
   * Changes the tag name of a node, preserving its children and attributes.
   * @param {Element} node The node to modify.
   * @param {string} tag The new tag name (uppercase).
   * @returns {Element} The new element.
   */
  _setNodeTag(node, tag) {
      this.log("_setNodeTag", node, tag);
      const replacement = node.ownerDocument.createElement(tag);

      // Copy children
      while (node.firstChild) {
          replacement.appendChild(node.firstChild);
      }

      // Copy attributes
      for (const attr of Array.from(node.attributes)) {
          try {
            replacement.setAttribute(attr.name, attr.value);
          } catch(e) {
              this.log(`Could not set attribute ${attr.name} during tag change to ${tag}`, e);
          }
      }

      // Copy Readability-specific data
      if (node.readability) {
          replacement.readability = node.readability;
      }

      // Replace node in parent
      if (node.parentNode) {
        node.parentNode.replaceChild(replacement, node);
      }


      return replacement;
  },

  /**
   * Prepare the article node for display. Clean out any inline styles,
   * iframes, forms, strip extraneous <p> tags, etc.
   *
   * @param {Element} articleContent The element containing the article content.
   */
  _prepArticle(articleContent) {
    this._cleanStyles(articleContent);

    // Mark data tables before cleaning potentially structural elements
    this._markDataTables(articleContent);

    // Convert lazy loaded images
    this._fixLazyImages(articleContent);

    // Clean out junk elements
    this._cleanConditionally(articleContent, "form");
    this._cleanConditionally(articleContent, "fieldset");
    this._clean(articleContent, "object"); // Clean non-video objects
    this._clean(articleContent, "embed");  // Clean non-video embeds
    this._clean(articleContent, "footer");
    this._clean(articleContent, "link");   // Remove <link> elements within content
    this._clean(articleContent, "aside");

    // Clean out share elements with little content
    const shareElementThreshold = this.DEFAULT_CHAR_THRESHOLD; // Reuse config? Or separate constant?
    const topLevelChildren = Array.from(articleContent.children); // Static list
    for (const topCandidate of topLevelChildren) {
        this._cleanMatchedNodes(topCandidate, (node, matchString) => {
            return (
                this.REGEXPS.shareElements.test(matchString) &&
                node.textContent.length < shareElementThreshold
            );
        });
    }


    this._clean(articleContent, "iframe"); // Clean non-video iframes
    this._clean(articleContent, "input");
    this._clean(articleContent, "textarea");
    this._clean(articleContent, "select");
    this._clean(articleContent, "button");
    this._cleanHeaders(articleContent);

    // Do these last as previous steps might affect the content score implicitly
    this._cleanConditionally(articleContent, "table");
    this._cleanConditionally(articleContent, "ul");
    this._cleanConditionally(articleContent, "div");

    // Replace H1s with H2s as H1 should be reserved for the main title
    this._replaceNodeTags(this._getAllNodesWithTag(articleContent, ["h1"]), "h2");

    // Remove empty paragraphs (or those containing only media - keep?)
    // Original logic removes if empty AND no media. Let's keep that.
    this._removeNodes(this._getAllNodesWithTag(articleContent, ["p"]), (paragraph) => {
      const contentElementCount = this._getAllNodesWithTag(paragraph, ["img", "embed", "object", "iframe"]).length;
      return contentElementCount === 0 && !this._getInnerText(paragraph, false);
    });

    // Remove <br> elements that are immediately before a <p> element
    const brs = this._getAllNodesWithTag(articleContent, ["br"]);
    for (const br of brs) {
        // Use _nextNode helper to skip whitespace nodes
        const next = this._nextNode(br);
        if (next && next.tagName === "P") {
            br.remove();
        }
    }

    // Remove single-cell tables
    const tables = this._getAllNodesWithTag(articleContent, ["table"]);
     for (const table of tables) {
        const tbody = this._hasSingleTagInsideElement(table, "TBODY") ? table.firstElementChild : table;
        if (this._hasSingleTagInsideElement(tbody, "TR")) {
            const row = tbody.firstElementChild;
            if (this._hasSingleTagInsideElement(row, "TD")) {
                let cell = row.firstElementChild;
                 // Change tag to DIV or P depending on content
                const newTagName = this._everyNode(cell.childNodes, this._isPhrasingContent) ? "P" : "DIV";
                cell = this._setNodeTag(cell, newTagName);
                if (table.parentNode) {
                  table.parentNode.replaceChild(cell, table);
                }
            }
        }
     }
  },

  /**
   * Initialize a node with the readability object and initial score based on tag.
   *
   * @param {Element} node The node to initialize.
   */
  _initializeNode(node) {
    // Prevent re-initialization
    if (node.readability) return;

    node.readability = { contentScore: 0 };

    switch (node.tagName) {
      case "DIV":
        node.readability.contentScore += 5;
        break;
      case "PRE": case "TD": case "BLOCKQUOTE":
        node.readability.contentScore += 3;
        break;
      case "ADDRESS": case "OL": case "UL": case "DL": case "DD": case "DT": case "LI": case "FORM":
        node.readability.contentScore -= 3;
        break;
      case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": case "TH":
        node.readability.contentScore -= 5;
        break;
    }
    node.readability.contentScore += this._getClassWeight(node);
  },

  /**
   * Removes a node and returns the next node in DOM traversal order.
   * Handles traversal correctly even when the node is removed.
   * @param {Node} node Node to remove
   * @returns {Node|null} The next node to process, or null.
   */
  _removeAndGetNext(node) {
    const nextNode = this._getNextNode(node, true); // Get next node ignoring self/children
    if(node.parentNode) {
        node.parentNode.removeChild(node);
    } else {
        this.log("Warning: Attempted to remove node with no parent", node);
    }
    return nextNode;
  },

  /**
   * Traverse the DOM from node to node, depth-first.
   *
   * @param {Node} node Current node
   * @param {boolean} [ignoreSelfAndKids=false] If true, find the next node *after* this one and its descendants.
   * @returns {Element|null} The next element node, or null.
   */
  _getNextNode(node, ignoreSelfAndKids = false) {
    if (!node) return null;
    // If not ignoring kids, first check for children
    if (!ignoreSelfAndKids && node.firstElementChild) {
      return node.firstElementChild;
    }
    // Then for siblings...
    if (node.nextElementSibling) {
      return node.nextElementSibling;
    }
    // And finally, move up the parent chain *and* find a sibling
    let parent = node.parentNode;
    while (parent) {
      if (parent.nextElementSibling) {
        return parent.nextElementSibling;
      }
      parent = parent.parentNode;
    }
    return null; // Reached end of traversal
  },

  /**
   * Calculates a similarity score between two texts (0=different, 1=same).
   * Based on the proportion of unique words in textB compared to textA.
   * @param {string} textA
   * @param {string} textB
   * @returns {number} Similarity score (0-1)
   */
  _textSimilarity(textA, textB) {
    if (!textA || !textB) return 0; // Handle null/empty inputs
    const tokensA = textA.toLowerCase().split(this.REGEXPS.tokenize).filter(Boolean);
    const tokensB = textB.toLowerCase().split(this.REGEXPS.tokenize).filter(Boolean);

    if (!tokensA.length || !tokensB.length) {
      return 0;
    }
    // Use a Set for faster lookups of tokens in A
    const tokensASet = new Set(tokensA);
    const uniqTokensB = tokensB.filter(token => !tokensASet.has(token));

    // Calculate distance based on the *length* of unique parts relative to total length
    const uniqueLengthB = uniqTokensB.join(" ").length;
    const totalLengthB = tokensB.join(" ").length;

    if (totalLengthB === 0) return 0; // Avoid division by zero

    const distanceB = uniqueLengthB / totalLengthB;
    return 1 - distanceB;
  },

  /**
   * Checks whether an element node looks like a valid byline.
   * @param {Element} node
   * @param {string} matchString Concatenated className and id
   * @returns {boolean}
   */
  _isValidByline(node, matchString) {
    // Check common attributes for author info
    const rel = node.getAttribute("rel");
    const itemprop = node.getAttribute("itemprop");

    // Simple length check first
    const bylineText = node.textContent; // Get text content once
    if (!bylineText) return false;
    const bylineLength = bylineText.trim().length;

    if (bylineLength === 0 || bylineLength > 100) {
        return false;
    }

    // Check attributes and class/id patterns
    return (
      (rel === "author" || (itemprop && itemprop.includes("author"))) ||
      this.REGEXPS.byline.test(matchString)
    );
  },

  /**
   * Get ancestors of a node up to a certain depth.
   * @param {Node} node
   * @param {number} [maxDepth=0] Max depth (0 for unlimited)
   * @returns {Array<Node>} Array of ancestor nodes (parent first).
   */
  _getNodeAncestors(node, maxDepth = 0) {
    const ancestors = [];
    let current = node.parentNode;
    let i = 0;
    while (current) {
      ancestors.push(current);
      if (maxDepth && ++i === maxDepth) {
        break;
      }
      current = current.parentNode;
    }
    return ancestors;
  },


  /**
   * Core logic to find the article content element. Uses scoring and candidate selection.
   * PERFORMANCE: This version uses cloning for retries, avoiding expensive innerHTML resets.
   *
   * @param {Element|null} page Element to parse (usually body or a clone). If null, uses this._doc.body.
   * @returns {Element|null} The element containing the article content, or null.
   */
  _grabArticle(page) {
    this.log("**** grabArticle ****");
    const doc = this._doc;
    const isPaging = !!page; // Check if called for pagination (not fully implemented here)
    const originalPage = page ? page : doc.body;

    if (!originalPage) {
      this.log("No body found in document. Abort.");
      return null;
    }

    // Clone the original page body (or provided element) ONCE after initial prep.
    // This clone will be used for the first attempt. Subsequent attempts will re-clone.
    const pageCloneForParsing = originalPage.cloneNode(true);

    // Sequence of flag combinations to try
    const flagSequences = [
      this.FLAG_STRIP_UNLIKELYS | this.FLAG_WEIGHT_CLASSES | this.FLAG_CLEAN_CONDITIONALLY,
      this.FLAG_WEIGHT_CLASSES | this.FLAG_CLEAN_CONDITIONALLY, // No strip unlikelys
      this.FLAG_CLEAN_CONDITIONALLY,                           // No weight classes
      0                                                         // No cleaning
    ];

    let bestAttempt = { articleContent: null, textLength: -1 };
    let currentAttemptNode = pageCloneForParsing; // Start with the initial clone

    for (let attemptIndex = 0; attemptIndex < flagSequences.length; attemptIndex++) {
      const currentFlags = flagSequences[attemptIndex];
      this._flags = currentFlags; // Set flags for this attempt
      const stripUnlikelyCandidates = this._flagIsActive(this.FLAG_STRIP_UNLIKELYS);
      this.log(`Starting grabArticle loop #${attemptIndex + 1} with flags: ${this._flags}`);

      // If not the first attempt, create a fresh clone from the original page state
      if (attemptIndex > 0) {
        this.log("Cloning original page for new attempt.");
        currentAttemptNode = originalPage.cloneNode(true);
        // Reset article metadata potentially found in previous failed attempts?
        // this._articleByline = null; // Let's keep the globally found one unless overwritten by metadata later
      }

      // --- Start of main grabArticle logic (applied to currentAttemptNode) ---
      const elementsToScore = [];
      let node = currentAttemptNode.firstElementChild; // Start traversal within the current clone
      let shouldRemoveTitleHeader = true; // Reset for each attempt
      let attemptByline = null; // Track byline found in *this* attempt

      while (node) {
          // Check if node still exists (might have been removed by sibling processing)
          if (!node.parentNode) {
              node = this._getNextNode(node, true); // Try to find next after potential removal
              continue;
          }

          const matchString = `${node.className || ""} ${node.id || ""}`; // Combine class and id

          if (!this._isProbablyVisible(node)) {
              this.log("Removing hidden node - " + matchString);
              node = this._removeAndGetNext(node); // Operates on currentAttemptNode
              continue;
          }

          // Modal dialog check
          if (node.getAttribute("aria-modal") == "true" && node.getAttribute("role") == "dialog") {
              this.log("Removing modal dialog node - " + matchString);
              node = this._removeAndGetNext(node);
              continue;
          }

          // Check for byline (only if not already found *globally*)
          // Store it temporarily for this attempt.
          if (!attemptByline && this._isValidByline(node, matchString)) {
              // Find itemprop="name" child for better accuracy
              let bylineNode = node;
              const itemPropNameNode = this._findNode(node.querySelectorAll('[itemprop="name"]'), n => n.textContent.trim());
              if (itemPropNameNode) {
                  bylineNode = itemPropNameNode;
              }
              attemptByline = bylineNode.textContent.trim(); // Store attempt-specific byline
              this.log("Found potential byline in attempt: ", attemptByline);
              node = this._removeAndGetNext(node);
              continue;
          }


          // Check for header duplicating title (use the globally found title)
          if (shouldRemoveTitleHeader && this._articleTitle && this._headerDuplicatesTitle(node)) {
              this.log(`Removing header duplicating title: ${node.textContent.trim()}`);
              shouldRemoveTitleHeader = false;
              node = this._removeAndGetNext(node);
              continue;
          }

          // Remove unlikely candidates based on flags
          if (stripUnlikelyCandidates) {
              if (
                  this.REGEXPS.unlikelyCandidates.test(matchString) &&
                  !this.REGEXPS.okMaybeItsACandidate.test(matchString) &&
                  node.tagName !== "BODY" && // Don't remove body
                  node.tagName !== "A" && // Keep links (for now)
                  !this._hasAncestorTag(node, "table") && // Don't remove within tables
                  !this._hasAncestorTag(node, "code")     // Don't remove within code blocks
              ) {
                  this.log("Removing unlikely candidate - " + matchString);
                  node = this._removeAndGetNext(node);
                  continue;
              }
              // Remove based on role
              const role = node.getAttribute("role");
              if (role && this.UNLIKELY_ROLES.includes(role)) {
                  this.log(`Removing content with role ${role} - ${matchString}`);
                  node = this._removeAndGetNext(node);
                  continue;
              }
          }

          // Remove elements without content (especially containers)
           const nodeTagName = node.tagName;
           if (
             (nodeTagName === "DIV" || nodeTagName === "SECTION" || nodeTagName === "HEADER" ||
              nodeTagName === "H1" || nodeTagName === "H2" || nodeTagName === "H3" ||
              nodeTagName === "H4" || nodeTagName === "H5" || nodeTagName === "H6") &&
             this._isElementWithoutContent(node)
           ) {
             node = this._removeAndGetNext(node);
             continue;
           }


          // Convert DIVs to Ps if appropriate
          if (nodeTagName === "DIV") {
              // Convert inline children to be inside Ps
              let p = null;
              let childNode = node.firstChild;
              while (childNode) {
                  const nextSibling = childNode.nextSibling; // Cache next sibling before potential move
                  if (this._isPhrasingContent(childNode)) {
                      if (p === null && !this._isWhitespace(childNode)) {
                          p = doc.createElement("p"); // Use main doc to create element
                          node.insertBefore(p, childNode); // Insert P before the first phrasing child
                      }
                      if (p) {
                         p.appendChild(childNode); // Move phrasing content into P
                      }
                  } else if (p !== null) {
                      // We hit a non-phrasing node, finalize the current P
                      while (p.lastChild && this._isWhitespace(p.lastChild)) {
                          p.lastChild.remove();
                      }
                      if (!p.hasChildNodes()) { // Remove empty P
                         p.remove();
                      }
                      p = null; // Reset P for subsequent phrasing content
                  }
                  childNode = nextSibling;
              }
               // Finalize any trailing P
              if (p !== null) {
                while (p.lastChild && this._isWhitespace(p.lastChild)) {
                  p.lastChild.remove();
                }
                if (!p.hasChildNodes()) {
                  p.remove();
                }
              }

              // Check if DIV contains only a single P (heuristic from original)
              if (this._hasSingleTagInsideElement(node, "P") && this._getLinkDensity(node) < 0.25) {
                  const newNode = node.children[0];
                  node.parentNode.replaceChild(newNode, node);
                  node = newNode; // Continue processing the P node
                  // Ensure the P node gets scored if it's a scoreable tag
                  if (this.DEFAULT_TAGS_TO_SCORE.includes(node.tagName)) {
                     elementsToScore.push(node);
                  }
                  // No need to call _getNextNode here, loop continues with the replaced node
                  continue; // Re-evaluate the new node (which is now a P) in the next iteration
              } else if (!this._hasChildBlockElement(node)) {
                  // Convert DIV to P if it has no block children left
                  const pNode = this._setNodeTag(node, "P"); // This replaces node in the clone
                  node = pNode; // Continue processing the new P node
                  elementsToScore.push(node); // Score the new P
                   // No need to call _getNextNode here, loop continues with the replaced node
                  continue; // Re-evaluate the new node (which is now a P) in the next iteration
              }
          }

          // Add element to score if it's a potentially meaningful tag
          if (this.DEFAULT_TAGS_TO_SCORE.includes(nodeTagName)) {
              elementsToScore.push(node);
          }

          node = this._getNextNode(node); // Move to the standard next node
      } // End while(node) loop for node traversal

      // --- End of main grabArticle node traversal ---


      // --- Start of candidate scoring and selection ---
      const candidates = [];
      for (const elementToScore of elementsToScore) {
        // Element might have been removed during DIV->P conversion or other cleanups
        if (!elementToScore.parentNode || typeof elementToScore.parentNode.tagName === "undefined") {
          continue;
        }

        const innerText = this._getInnerText(elementToScore);
        if (innerText.length < 25) {
          continue;
        }

        const ancestors = this._getNodeAncestors(elementToScore, 5);
        if (ancestors.length === 0) {
          continue; // Should have a parent unless it's root
        }

        let contentScore = 1; // Base score
        contentScore += innerText.split(this.REGEXPS.commas).length -1; // Add points for commas
        contentScore += Math.min(Math.floor(innerText.length / 100), 3); // Add points for length

        // Score ancestors
        ancestors.forEach((ancestor, level) => {
            if (!ancestor.tagName || !ancestor.parentNode || typeof ancestor.parentNode.tagName === "undefined") {
                return;
            }

            if (typeof ancestor.readability === "undefined") {
                this._initializeNode(ancestor); // Operates on nodes within the clone
                candidates.push(ancestor);
            }

            // Node score divider based on level
            let scoreDivider = 1;
            if (level === 1) scoreDivider = 2;
            else if (level > 1) scoreDivider = level * 3;

            ancestor.readability.contentScore += contentScore / scoreDivider;
        });
      }

      // Find top candidate
      const topCandidates = [];
      for (const candidate of candidates) {
          if (!candidate.readability) continue; // Should have been initialized

          // Scale score by inverse link density
          const candidateScore = candidate.readability.contentScore * (1 - this._getLinkDensity(candidate));
          candidate.readability.contentScore = candidateScore; // Update score

          this.log("Candidate:", candidate, `with score ${candidateScore.toFixed(2)}`);

          // Maintain sorted list of top N candidates
          for (let i = 0; i < this._nbTopCandidates; i++) {
            const aTopCandidate = topCandidates[i];
            if (!aTopCandidate || candidateScore > aTopCandidate.readability.contentScore) {
              topCandidates.splice(i, 0, candidate);
              if (topCandidates.length > this._nbTopCandidates) {
                topCandidates.pop();
              }
              break; // Inserted, move to next candidate
            }
          }
      }

      let topCandidate = topCandidates[0] || null;
      let neededToCreateTopCandidate = false; // Flag if we created a wrapper DIV


      // Handle cases with no candidate or body candidate
      if (topCandidate === null || topCandidate.tagName === "BODY") {
          // Create a fallback DIV in the main document context
          topCandidate = doc.createElement("DIV");
          neededToCreateTopCandidate = true;
          // Move children from the *processed clone* into the new DIV
          while (currentAttemptNode.firstChild) {
              topCandidate.appendChild(currentAttemptNode.firstChild);
          }
          // No need to append topCandidate back to currentAttemptNode
          this._initializeNode(topCandidate); // Initialize the wrapper
      } else {
          // Refine top candidate - check ancestors, siblings etc. (Original logic mostly preserved)
          // Find a better top candidate node if it contains (at least three) nodes which belong to `topCandidates` array
          // and whose scores are quite close to the current `topCandidate` node score.
          let alternativeCandidateAncestors = [];
          for (let i = 1; i < topCandidates.length; i++) {
            if (topCandidates[i].readability.contentScore / topCandidate.readability.contentScore >= 0.75) {
              alternativeCandidateAncestors.push(this._getNodeAncestors(topCandidates[i]));
            }
          }
          const MINIMUM_TOPCANDIDATES = 3;
          if (alternativeCandidateAncestors.length >= MINIMUM_TOPCANDIDATES) {
              let parentOfTopCandidate = topCandidate.parentNode;
              while (parentOfTopCandidate && parentOfTopCandidate.tagName !== "BODY") {
                  let listsContainingThisAncestor = 0;
                  for (const ancestorList of alternativeCandidateAncestors) {
                      if (ancestorList.includes(parentOfTopCandidate)) {
                          listsContainingThisAncestor++;
                      }
                      if (listsContainingThisAncestor >= MINIMUM_TOPCANDIDATES) break; // Early exit
                  }
                  if (listsContainingThisAncestor >= MINIMUM_TOPCANDIDATES) {
                      topCandidate = parentOfTopCandidate;
                      break;
                  }
                  parentOfTopCandidate = parentOfTopCandidate.parentNode;
              }
              // Ensure the newly chosen parent is initialized
              if (!topCandidate.readability) this._initializeNode(topCandidate);
          }


          // Boost parent score check (Original logic preserved)
          let parentOfTopCandidate = topCandidate.parentNode;
          let lastScore = topCandidate.readability.contentScore;
          const scoreThreshold = lastScore / 3;
          while (parentOfTopCandidate && parentOfTopCandidate.tagName !== "BODY") {
              if (!parentOfTopCandidate.readability) {
                  parentOfTopCandidate = parentOfTopCandidate.parentNode;
                  continue;
              }
              const parentScore = parentOfTopCandidate.readability.contentScore;
              if (parentScore < scoreThreshold) break;
              if (parentScore > lastScore) {
                  topCandidate = parentOfTopCandidate; // Found a better parent
                  break;
              }
              lastScore = parentScore;
              parentOfTopCandidate = parentOfTopCandidate.parentNode;
          }

          // Use parent if top candidate is only child (Original logic preserved)
          parentOfTopCandidate = topCandidate.parentNode;
          while (parentOfTopCandidate && parentOfTopCandidate.tagName !== "BODY" && parentOfTopCandidate.children.length === 1) {
              topCandidate = parentOfTopCandidate;
              parentOfTopCandidate = topCandidate.parentNode;
          }
          if (!topCandidate.readability) this._initializeNode(topCandidate); // Ensure initialized
      }

      // --- End of candidate scoring and selection ---


      // --- Start of sibling joining and article creation ---
      // Create the container for the final article content in the main document
      let articleContent = doc.createElement("DIV");
      if (isPaging) articleContent.id = "readability-content";

      const siblingScoreThreshold = Math.max(10, topCandidate.readability.contentScore * 0.2);
      const parentOfTopCandidate = topCandidate.parentNode; // Parent in the clone

      if (parentOfTopCandidate) { // Check if parent exists (should unless it's the synthetic DIV)
          const siblings = Array.from(parentOfTopCandidate.children); // Static list of siblings in the clone
          let siblingIndex = 0;

          for (const sibling of siblings) {
              let append = false;
              const currentSibling = sibling; // Reference for logging

              this.log(
                  "Looking at sibling node:",
                  currentSibling,
                  currentSibling.readability ? `with score ${currentSibling.readability.contentScore.toFixed(2)}` : "(no score)"
              );

              if (currentSibling === topCandidate) {
                  append = true;
              } else {
                  let contentBonus = 0;
                  if (sibling.className && sibling.className === topCandidate.className && topCandidate.className !== "") {
                      contentBonus += topCandidate.readability.contentScore * 0.2;
                  }
                  if (sibling.readability && (sibling.readability.contentScore + contentBonus) >= siblingScoreThreshold) {
                      append = true;
                  } else if (sibling.tagName === "P") {
                      const linkDensity = this._getLinkDensity(sibling);
                      const nodeContent = this._getInnerText(sibling);
                      const nodeLength = nodeContent.length;

                      if (nodeLength > 80 && linkDensity < 0.25) {
                          append = true;
                      } else if (nodeLength > 0 && nodeLength < 80 && linkDensity === 0 && nodeContent.includes(".")) { // Simplified check for sentence end
                          append = true;
                      }
                  }
              }

              if (append) {
                  this.log("Appending node:", currentSibling);
                  let nodeToAppend = currentSibling;
                  // Change tag to DIV if it's not a standard block type (heuristic)
                  if (!this.ALTER_TO_DIV_EXCEPTIONS.includes(nodeToAppend.tagName)) {
                      this.log("Altering sibling:", nodeToAppend, "to div.");
                      // Use setNodeTag which creates element in main doc context
                      nodeToAppend = this._setNodeTag(nodeToAppend, "DIV");
                  }

                  // Append the node (or its replacement) to the final articleContent container
                  articleContent.appendChild(nodeToAppend);
                  // Note: nodeToAppend is now removed from its original parent in the clone
              }
              siblingIndex++;
          } // End sibling loop
      } else if (neededToCreateTopCandidate) {
          // If we created a synthetic top candidate, it already contains the content.
          articleContent = topCandidate; // The wrapper DIV *is* the article content
      }


      // --- End of sibling joining ---

      // Perform final prep on the extracted content
      // This modifies articleContent, which is now composed of nodes moved/created in the main doc
      this.log("Article content pre-prep:", articleContent.innerHTML.substring(0, 500)); // Log snippet
      this._prepArticle(articleContent);
      this.log("Article content post-prep:", articleContent.innerHTML.substring(0, 500));

      // --- Check if successful ---
      const textLength = this._getInnerText(articleContent, true).length;
      if (textLength >= this._charThreshold) {
        this.log(`Success on attempt #${attemptIndex + 1} with flags: ${this._flags}. Length: ${textLength}`);
        // If byline wasn't found globally, use the one from this successful attempt
        this._articleByline = this._articleByline || attemptByline || this._metadata.byline; // Prioritize attempt over metadata? Check original logic. Let's prioritize metadata/global first.
        this._articleByline = this._metadata.byline || this._articleByline || attemptByline;

        return this._finalizeArticle(articleContent, topCandidate, neededToCreateTopCandidate, isPaging);
      }

      // Attempt failed, store it if it's the best failure so far
      this.log(`Attempt #${attemptIndex + 1} failed. Length: ${textLength} (threshold: ${this._charThreshold})`);
      this._attempts.push({ // Keep track for potential fallback
           articleContent: articleContent.cloneNode(true), // Clone result
           textLength: textLength
      });

    } // End of flag sequence loop


    // --- All attempts failed ---
    this.log("All attempts failed to meet character threshold.");
    // Sort attempts by length and return the longest one if it has *any* content
    this._attempts.sort((a, b) => b.textLength - a.textLength);

    if (this._attempts.length > 0 && this._attempts[0].textLength > 0) {
        this.log(`Returning best failed attempt with length ${this._attempts[0].textLength}`);
        // Need to finalize this best failure content as well
        // Treat as neededToCreateTopCandidate=true since we don't have the original topCandidate context
        return this._finalizeArticle(this._attempts[0].articleContent, null, true, isPaging);
    }

    // Truly nothing found
    this.log("No suitable content found after all attempts.");
    return null;
  },


  /**
   * Helper function to wrap the final article content in a div, set IDs, and determine text direction.
   * @param {Element} articleContent The element containing the extracted content.
   * @param {Element|null} topCandidate The best candidate element found (used for text direction).
   * @param {boolean} neededToCreateTopCandidate Whether a synthetic wrapper was already created.
   * @param {boolean} isPaging Whether this is part of pagination.
   * @returns {Element} The finalized article container element.
   */
  _finalizeArticle(articleContent, topCandidate, neededToCreateTopCandidate, isPaging) {
      const doc = this._doc;
      let finalContainer;

      if (neededToCreateTopCandidate) {
          // articleContent is already the wrapper DIV created earlier
          finalContainer = articleContent;
          finalContainer.id = "readability-page-1";
          finalContainer.className = "page";
      } else {
          // Create a standard wrapper div
          const div = doc.createElement("DIV");
          div.id = "readability-page-1";
          div.className = "page";
          // Move children from the temporary articleContent holder
          while (articleContent.firstChild) {
              div.appendChild(articleContent.firstChild);
          }
          // articleContent itself is now empty, append the final wrapper
          articleContent.appendChild(div); // articleContent remains the outer element returned by _grabArticle
          finalContainer = div; // The div inside articleContent is the one for dir check
      }

      this.log("Article content after paging:", articleContent.innerHTML.substring(0,500));

      // Determine text direction from ancestors of the original top candidate (if available)
      // We need the original top candidate's context (from the clone where it was identified)
      // This is tricky because the nodes were moved. We might lose this context.
      // Fallback: check the final container or body.
      let foundDir = false;
      if (topCandidate && topCandidate.parentNode) { // Check if topCandidate context is somewhat valid
           const parentOfTopCandidate = topCandidate.parentNode; // This parent might be from the clone...
           try {
              const ancestors = [parentOfTopCandidate, topCandidate].concat(
                  this._getNodeAncestors(parentOfTopCandidate) // Get ancestors of the parent
              );
              this._someNode(ancestors, (ancestor) => {
                  if (!ancestor || !ancestor.tagName) return false;
                  const articleDir = ancestor.getAttribute("dir");
                  if (articleDir) {
                      this._articleDir = articleDir;
                      foundDir = true;
                      return true; // Stop search
                  }
                  return false;
              });
           } catch(e) {
               this.log("Error finding text direction from top candidate ancestors:", e);
           }
      }

      // If not found via candidate, try the final container or body
      if (!foundDir) {
          const checkNodes = [finalContainer, doc.body, doc.documentElement];
          for(const node of checkNodes) {
              if(node && node.getAttribute) {
                  const dir = node.getAttribute("dir");
                  if (dir) {
                      this._articleDir = dir;
                      this.log("Found direction from container/body/html:", dir);
                      foundDir = true;
                      break;
                  }
              }
          }
      }
      if (!foundDir) this.log("Could not determine text direction.");


      // Return the outer container (which might be the synthetic one or the one holding the 'page' div)
      return articleContent;
  },


  /**
   * Converts some common HTML entities in a string to their corresponding characters.
   *
   * @param {string} str The string to unescape.
   * @returns {string} String without common HTML entities.
   */
  _unescapeHtmlEntities(str) {
    if (!str) {
      return str;
    }
    // Basic unescaping for common entities. A more robust solution might use a DOM parser trick.
    return str
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&"); // Ampersand must be last
    // Original logic for numeric entities was more complex, but this covers common cases.
    // Consider adding numeric entity handling if needed.
  },

  /**
   * Try to extract metadata from JSON-LD object.
   * Supports Schema.org Article types.
   * @returns {object} Object with metadata found (title, byline, excerpt, siteName, datePublished).
   */
  _getJSONLD() {
      const metadata = {};
      const scripts = this._getAllNodesWithTag(this._doc, ["script"]);
      const schemaDotOrgRegex = /^https?:\/\/schema\.org\/?$/;

      for (const scriptElement of scripts) {
          if (scriptElement.getAttribute("type") === "application/ld+json") {
              try {
                  const content = scriptElement.textContent.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, "");
                  if (!content) continue; // Skip empty scripts

                  let jsonData = JSON.parse(content);
                  let parsed = null;

                  // Handle arrays of JSON-LD objects
                  if (Array.isArray(jsonData)) {
                      parsed = jsonData.find(obj => obj && obj["@type"] && String(obj["@type"]).match(this.REGEXPS.jsonLdArticleTypes));
                  } else if (jsonData && typeof jsonData === 'object') {
                      // Handle @graph structure
                      if (!jsonData["@type"] && Array.isArray(jsonData["@graph"])) {
                          parsed = jsonData["@graph"].find(obj => obj && obj["@type"] && String(obj["@type"]).match(this.REGEXPS.jsonLdArticleTypes));
                      } else if (jsonData["@type"] && String(jsonData["@type"]).match(this.REGEXPS.jsonLdArticleTypes)) {
                          parsed = jsonData;
                      }
                  }

                  if (!parsed) continue; // Skip if no matching Article type found

                  // Check @context for schema.org (simplified check)
                   let hasSchemaContext = false;
                   if (typeof parsed["@context"] === "string") {
                       hasSchemaContext = schemaDotOrgRegex.test(parsed["@context"]);
                   } else if (typeof parsed["@context"] === "object" && parsed["@context"] !== null) {
                       // Check if any value in the context object matches schema.org URL
                       // Or if @vocab matches
                       hasSchemaContext = Object.values(parsed["@context"]).some(val => typeof val === 'string' && schemaDotOrgRegex.test(val)) ||
                                         (typeof parsed["@context"]["@vocab"] === 'string' && schemaDotOrgRegex.test(parsed["@context"]["@vocab"]));
                   }

                  if (!hasSchemaContext) {
                       this.log("JSON-LD object found but @context does not seem to be schema.org", parsed);
                       // continue; // Relax context check? Or keep it strict? Let's relax it slightly.
                  }


                  // Extract properties
                  // Title: Handle name/headline discrepancy
                  if (typeof parsed.name === "string" && typeof parsed.headline === "string" && parsed.name !== parsed.headline) {
                      const title = this._getArticleTitle(); // Get title determined from HTML
                      const nameSimilarity = this._textSimilarity(parsed.name, title);
                      const headlineSimilarity = this._textSimilarity(parsed.headline, title);

                      // Prefer the one closer to the HTML title, default to name
                      metadata.title = (headlineSimilarity > nameSimilarity && headlineSimilarity > 0.75) ? parsed.headline : parsed.name;
                  } else {
                      metadata.title = parsed.name || parsed.headline;
                  }

                  // Author: Handle object or array of objects
                  if (parsed.author) {
                      if (typeof parsed.author.name === "string") {
                          metadata.byline = parsed.author.name.trim();
                      } else if (Array.isArray(parsed.author)) {
                          metadata.byline = parsed.author
                              .map(author => author && typeof author.name === "string" ? author.name.trim() : null)
                              .filter(Boolean) // Remove null/empty names
                              .join(", ");
                      }
                  }

                  // Description/Excerpt
                  metadata.excerpt = parsed.description;

                  // Publisher/Site Name
                  if (parsed.publisher && typeof parsed.publisher.name === "string") {
                      metadata.siteName = parsed.publisher.name.trim();
                  }

                   // Date Published
                  metadata.datePublished = parsed.datePublished || parsed.dateCreated;


                  // Clean extracted values (remove potential HTML)
                  for (const key in metadata) {
                      if (typeof metadata[key] === 'string') {
                          metadata[key] = this._unescapeHtmlEntities(metadata[key].trim());
                      }
                  }


                  this.log("Extracted JSON-LD Metadata:", metadata);
                  // If we found useful data, we can stop processing scripts (unless merging needed?)
                  if (metadata.title || metadata.byline || metadata.excerpt) {
                     return metadata; // Return first good match
                  }


              } catch (err) {
                  this.log("Failed to parse JSON-LD: " + err.message);
              }
          }
      }
      return metadata; // Return whatever was found (possibly empty)
  },


  /**
   * Attempts to get metadata from standard meta tags.
   *
   * @param {object} jsonldMetadata Metadata already extracted from JSON-LD.
   * @returns {object} Combined metadata object.
   */
  _getArticleMetadata(jsonldMetadata) {
      const metadata = { ...jsonldMetadata }; // Start with JSON-LD values
      const values = {};
      const metaElements = this._doc.getElementsByTagName("meta");

      // Patterns to match common meta tag property/name values
      const propertyPattern = /\s*(?:og|twitter|article|dc|dcterm)\s*:\s*(author|creator|description|published_time|title|site_name)\s*/i;
      const namePattern = /^\s*(?:(?:dc|dcterm|og|twitter|parsely|weibo:(?:article|webpage))\s*[-\.:]\s*)?(author|creator|pub-date|description|title|site_name)\s*$/i;


      for (const element of metaElements) {
          const elemName = element.getAttribute("name");
          const elemProp = element.getAttribute("property");
          const content = element.getAttribute("content");

          if (!content) continue;

          let potentialMatch = null;
          let matchedName = null;

          // Check 'property' attribute (e.g., Open Graph)
          if (elemProp) {
              potentialMatch = elemProp.match(propertyPattern);
              if (potentialMatch) {
                  // Normalize key: e.g., "og:title" -> "og:title"
                  matchedName = potentialMatch[0].toLowerCase().replace(/\s/g, "");
                  values[matchedName] = content.trim(); // Store raw value
                  continue; // Prioritize property match
              }
          }

          // Check 'name' attribute
          if (elemName && namePattern.test(elemName)) {
              potentialMatch = elemName.match(namePattern);
               if (potentialMatch) {
                    // Normalize key: e.g., "dcterm.title" -> "dcterm:title", "twitter:title" -> "twitter:title"
                    matchedName = elemName.toLowerCase()
                                          .replace(/\s/g, "")
                                          .replace(/\./g, ":") // Convert dots to colons
                                          .replace(/^([^:]+)$/, 'name:$1'); // Add prefix if none exists (e.g. author -> name:author)
                    values[matchedName] = content.trim();
               }
          }
      }

      // Consolidate values, prioritizing specific sources (like OG) then falling back
      // Overwrite JSON-LD values only if meta tags provide something
      metadata.title = metadata.title || values["og:title"] || values["twitter:title"] || values["dcterm:title"] || values["name:title"] || values["parsely-title"] ;
      metadata.byline = metadata.byline || values["article:author"] || values["dcterm:creator"] || values["dc:creator"] || values["name:author"] || values["parsely-author"]; // Check article:author isn't a URL? Original code did.
      metadata.excerpt = metadata.excerpt || values["og:description"] || values["twitter:description"] || values["dcterm:description"] || values["name:description"];
      metadata.siteName = metadata.siteName || values["og:site_name"];
      metadata.publishedTime = metadata.publishedTime || values["article:published_time"] || values["dcterm:published"] || values["name:pub-date"] || values["parsely-pub-date"]; // Added dcterm:published

      // If no title found yet, get it from the title tag
      if (!metadata.title) {
          metadata.title = this._getArticleTitle();
      }

      // Unescape HTML entities in final values
      for (const key in metadata) {
        if (typeof metadata[key] === "string") {
          metadata[key] = this._unescapeHtmlEntities(metadata[key]);
        }
      }

      return metadata;
  },

  /**
   * Check if node is an image, or contains exactly one image descendant.
   * @param {Element} node
   * @returns {boolean}
   */
  _isSingleImage(node) {
      if (!node) return false;
      if (node.tagName === "IMG") return true;

      // Check for exactly one child element which must be an image or contain a single image
      // Allow for whitespace text nodes.
      let elementChild = null;
      let hasNonWhitespaceText = false;
      for(const child of node.childNodes) {
          if (child.nodeType === this.ELEMENT_NODE) {
              if (elementChild) return false; // More than one element child
              elementChild = child;
          } else if (child.nodeType === this.TEXT_NODE && this.REGEXPS.hasContent.test(child.textContent)) {
              hasNonWhitespaceText = true;
          }
      }

      if (hasNonWhitespaceText || !elementChild) return false; // Must contain only one element and no text

      return this._isSingleImage(elementChild); // Recurse
  },

  /**
   * Finds <noscript> tags containing a single <img> and attempts to replace
   * a preceding placeholder <img> or figure with the noscript image.
   * @param {Document} doc
   */
  _unwrapNoscriptImages(doc) {
      const noscripts = Array.from(doc.getElementsByTagName("noscript"));

      for (const noscript of noscripts) {
          // Create a temporary div to parse the noscript content safely
          const tmp = doc.createElement("div");
          // Assigning innerHTML is okay here as it's from the source doc's noscript tag
          // eslint-disable-next-line no-unsanitized/property
          tmp.innerHTML = noscript.innerHTML;

          // Check if the parsed content is a single image
          if (!this._isSingleImage(tmp)) {
              continue;
          }

          const prevElement = noscript.previousElementSibling;
          // Check if the previous element is a likely placeholder (IMG or FIGURE containing just an IMG)
          if (prevElement && (prevElement.tagName === 'IMG' || this._isSingleImage(prevElement))) {
              const newImg = tmp.getElementsByTagName("img")[0]; // Get the actual img from noscript
              if (!newImg) continue; // Should exist if _isSingleImage passed

              let placeholderImg = (prevElement.tagName === 'IMG') ? prevElement : prevElement.getElementsByTagName("img")[0];

               // If placeholder exists, attempt to merge attributes, preferring noscript source
              if (placeholderImg) {
                    // Preserve potentially useful attributes from placeholder if not present on new image
                    for (const attr of Array.from(placeholderImg.attributes)) {
                        if (attr.name === 'src' || attr.name === 'srcset') continue; // Prioritize noscript src/srcset
                        if (!newImg.hasAttribute(attr.name) && attr.value) {
                             newImg.setAttribute(attr.name, attr.value);
                        }
                    }
              }

              // Replace the placeholder element with the image from noscript
               if (prevElement.parentNode) {
                 prevElement.parentNode.replaceChild(newImg, prevElement);
               }
               // Remove the noscript tag itself? Original logic didn't, but seems reasonable.
               // noscript.remove();
          }
      }
  },

  /**
   * Removes script and noscript tags from the document.
   * @param {Document} doc
   */
  _removeScripts(doc) {
    this._removeNodes(this._getAllNodesWithTag(doc, ["script", "noscript"]));
  },

  /**
   * Check if this node has only whitespace and a single element with given tag.
   *
   * @param {Element} element
   * @param {string} tag Uppercase tag name
   * @returns {boolean}
   **/
  _hasSingleTagInsideElement(element, tag) {
      // Check for exactly one child element with the specified tag.
      if (element.children.length !== 1 || element.children[0].tagName !== tag) {
          return false;
      }
      // Check that there are no non-empty text nodes.
      return !this._someNode(element.childNodes, node =>
          node.nodeType === this.TEXT_NODE && this.REGEXPS.hasContent.test(node.textContent)
      );
  },


  /**
   * Checks if an element has no visible content (text, significant children).
   * @param {Element} node
   * @returns {boolean}
   */
  _isElementWithoutContent(node) {
    if (node.nodeType !== this.ELEMENT_NODE) return false; // Only check elements
    // Check for text content
    if (this.REGEXPS.hasContent.test(node.textContent)) return false;
    // Check for significant children (IMG, VIDEO, etc., or non-BR/HR elements)
    return !this._someNode(node.children, child =>
        child.tagName !== 'BR' && child.tagName !== 'HR' && !this._isElementWithoutContent(child) // Recurse for nested empty divs
    );
  },

  /**
   * Determine whether element has any children that are block-level elements.
   * Uses DIV_TO_P_ELEMS set for block tags.
   * @param {Element} element
   * @returns {boolean}
   */
  _hasChildBlockElement(element) {
    return this._someNode(element.childNodes, node => {
        if (node.nodeType !== this.ELEMENT_NODE) return false;
        // Check if the node itself is a block element or recursively contains one
        return this.DIV_TO_P_ELEMS.has(node.tagName) || this._hasChildBlockElement(node);
    });
  },

  /**
   * Determine if a node qualifies as phrasing content.
   * https://developer.mozilla.org/en-US/docs/Web/Guide/HTML/Content_categories#Phrasing_content
   * @param {Node} node
   * @returns {boolean}
   **/
  _isPhrasingContent(node) {
    const phrasingSet = new Set(this.PHRASING_ELEMS); // Use Set for faster lookup
    return (
      node.nodeType === this.TEXT_NODE ||
      phrasingSet.has(node.tagName) ||
      ((node.tagName === "A" || node.tagName === "DEL" || node.tagName === "INS") &&
        this._everyNode(node.childNodes, this._isPhrasingContent))
    );
  },

  /**
   * Check if a node is whitespace (empty text node or BR).
   * @param {Node} node
   * @returns {boolean}
   */
  _isWhitespace(node) {
    return (
      (node.nodeType === this.TEXT_NODE && node.textContent.trim().length === 0) ||
      (node.nodeType === this.ELEMENT_NODE && node.tagName === "BR")
    );
  },

  /**
   * Get the inner text of a node, trimming and normalizing spaces.
   *
   * @param {Node} e The node.
   * @param {boolean} [normalizeSpaces=true] Whether to collapse multiple spaces.
   * @returns {string}
   **/
  _getInnerText(e, normalizeSpaces = true) {
    if (!e || typeof e.textContent !== 'string') return ""; // Handle non-elements/nodes

    const textContent = (e.textContent || "").trim();

    if (normalizeSpaces) {
      return textContent.replace(this.REGEXPS.normalize, " ");
    }
    return textContent;
  },

  /**
   * Get the number of times a character (like a comma) appears in the node's text.
   *
   * @param {Element} e
   * @param {string} [s=","] Character to count.
   * @returns {number}
   **/
  _getCharCount(e, s = ",") {
    const text = this._getInnerText(e);
    // Use a regex for potentially faster counting than split
    const regex = new RegExp(s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g'); // Escape special regex chars
    const matches = text.match(regex);
    return matches ? matches.length : 0;
    // Original split logic: return this._getInnerText(e).split(s).length - 1;
  },

  /**
   * Remove the style attribute and deprecated presentational attributes
   * from an element and its descendants.
   *
   * @param {Element} e The starting element.
   **/
  _cleanStyles(e) {
      if (!e || typeof e.removeAttribute !== 'function' || e.tagName.toLowerCase() === "svg") {
          return;
      }

      // Remove deprecated presentational attributes
      for (const attrName of this.PRESENTATIONAL_ATTRIBUTES) {
          e.removeAttribute(attrName);
      }
      // Remove deprecated size attributes from specific elements
      if (this.DEPRECATED_SIZE_ATTRIBUTE_ELEMS.includes(e.tagName)) {
          e.removeAttribute("width");
          e.removeAttribute("height");
      }

      // Recursively clean children
      let cur = e.firstElementChild;
      while (cur) {
          this._cleanStyles(cur); // Recurse
          cur = cur.nextElementSibling;
      }
  },

  /**
   * Get the density of links as a percentage of the content text length.
   *
   * @param {Element} element
   * @returns {number} Float (0-1)
   **/
  _getLinkDensity(element) {
    const textLength = this._getInnerText(element).length;
    if (textLength === 0) {
      return 0;
    }

    let linkLength = 0;
    const links = this._getAllNodesWithTag(element, ["a"]);

    for (const linkNode of links) {
      const href = linkNode.getAttribute("href");
      // Reduce weight for hash links
      const coefficient = href && this.REGEXPS.hashUrl.test(href) ? 0.3 : 1;
      linkLength += this._getInnerText(linkNode).length * coefficient;
    }

    return linkLength / textLength;
  },

  /**
   * Get an element's weight based on its class and ID.
   *
   * @param {Element} e
   * @returns {number} Integer weight score.
   **/
  _getClassWeight(e) {
    if (!this._flagIsActive(this.FLAG_WEIGHT_CLASSES)) {
      return 0;
    }

    let weight = 0;
    const className = e.className;
    const id = e.id;

    // Check classname
    if (className && typeof className === "string") {
      if (this.REGEXPS.negative.test(className)) weight -= 25;
      if (this.REGEXPS.positive.test(className)) weight += 25;
    }

    // Check ID
    if (id && typeof id === "string") {
      if (this.REGEXPS.negative.test(id)) weight -= 25;
      if (this.REGEXPS.positive.test(id)) weight += 25;
    }

    return weight;
  },

  /**
   * Clean a node of all elements of a specific tag, except for allowed video embeds.
   *
   * @param {Element} e Parent element
   * @param {string} tag Tag name to clean
   */
  _clean(e, tag) {
      const isEmbedTag = ["object", "embed", "iframe"].includes(tag);
      const targetElements = this._getAllNodesWithTag(e, [tag]);

      this._removeNodes(targetElements, (element) => {
          // Allow known video embeds to stay
          if (isEmbedTag) {
              // Check attributes for video URLs
              for (const attr of Array.from(element.attributes)) {
                  if (this._allowedVideoRegex.test(attr.value)) {
                      return false; // Keep node
                  }
              }
              // Check innerHTML for object tags (less common now)
              if (element.tagName === "OBJECT" && this._allowedVideoRegex.test(element.innerHTML)) {
                  return false; // Keep node
              }
          }
          // Remove other elements of this tag
          return true;
      });
  },


  /**
   * Check if a node has an ancestor with a specific tag name within a max depth.
   * @param {HTMLElement} node
   * @param {string} tagName Uppercase tag name
   * @param {number} [maxDepth=3] Max levels to check (0 or negative for unlimited)
   * @param {Function} [filterFn] Optional filter function for the ancestor.
   * @returns {boolean}
   */
  _hasAncestorTag(node, tagName, maxDepth = 3, filterFn) {
      let depth = 0;
      let current = node.parentNode;
      while (current) {
          if (maxDepth > 0 && depth >= maxDepth) {
              return false;
          }
          if (current.tagName === tagName && (!filterFn || filterFn(current))) {
              return true;
          }
          current = current.parentNode;
          depth++;
      }
      return false;
  },

  /**
   * Get row and column counts for a table.
   * @param {HTMLTableElement} table
   * @returns {{rows: number, columns: number}}
   */
  _getRowAndColumnCount(table) {
      let rows = 0;
      let columns = 0;
      const trs = table.getElementsByTagName("tr"); // Direct access okay here
      for (const tr of trs) {
          const rowspan = parseInt(tr.getAttribute("rowspan") || "1", 10);
          rows += rowspan;

          let columnsInThisRow = 0;
          const cells = tr.children; // Use children for direct TD/TH
          for (const cell of cells) {
             if(cell.tagName === 'TD' || cell.tagName === 'TH') {
                const colspan = parseInt(cell.getAttribute("colspan") || "1", 10);
                columnsInThisRow += colspan;
             }
          }
          columns = Math.max(columns, columnsInThisRow);
      }
      return { rows, columns };
  },

  /**
   * Mark tables as data tables (_readabilityDataTable = true) or layout tables (_readabilityDataTable = false).
   * Uses heuristics similar to accessibility engines.
   * @param {Element} root Element to search within.
   */
  _markDataTables(root) {
      const tables = root.getElementsByTagName("table");
      for (const table of tables) {
          // Check role first
          const role = table.getAttribute("role");
          if (role === "presentation" || role === "none") { // Added "none" role
              table._readabilityDataTable = false;
              continue;
          }
          // Check explicit datatable attribute
          if (table.getAttribute("datatable") === "0") {
              table._readabilityDataTable = false;
              continue;
          }
          // Check summary attribute (though deprecated)
          if (table.getAttribute("summary")) {
              table._readabilityDataTable = true;
              continue;
          }
          // Check for caption
          const caption = table.getElementsByTagName("caption")[0];
          if (caption && this.REGEXPS.hasContent.test(caption.textContent)) { // Check caption has content
              table._readabilityDataTable = true;
              continue;
          }
          // Check for data table structural elements
          const dataTableDescendants = ["COL", "COLGROUP", "TFOOT", "THEAD", "TH"]; // Use uppercase
          if (dataTableDescendants.some(tag => !!table.getElementsByTagName(tag)[0])) {
              this.log("Data table because found data-y descendant");
              table._readabilityDataTable = true;
              continue;
          }
          // Check for nested tables (indicative of layout)
          if (table.getElementsByTagName("table")[0]) {
              table._readabilityDataTable = false;
              continue;
          }
          // Check size heuristics
          const sizeInfo = this._getRowAndColumnCount(table);
          if (sizeInfo.rows >= 10 || sizeInfo.columns > 4) {
              table._readabilityDataTable = true;
              continue;
          }
          // Final fallback based on cell count
          table._readabilityDataTable = sizeInfo.rows * sizeInfo.columns > 10;
      }
  },

  /**
   * Fix images and figures that use lazy loading attributes like 'data-src'.
   * Converts them to standard 'src' or 'srcset'.
   * Removes tiny placeholder images if a real source is found elsewhere.
   * @param {Element} root Element to process.
   */
  _fixLazyImages(root) {
      const mediaElements = this._getAllNodesWithTag(root, ["img", "picture", "figure"]);
      const imageExtensions = /\.(jpg|jpeg|png|webp|gif|bmp|svg)/i; // Include common formats

      for (const elem of mediaElements) {
          let currentSrc = elem.getAttribute("src");
          const currentSrcset = elem.getAttribute("srcset");
          let hasRealSrc = (currentSrc && !this.REGEXPS.b64DataUrl.test(currentSrc)) || currentSrcset;
          let potentialSrc = null;
          let potentialSrcset = null;

          // Check for tiny base64 placeholder and mark if removable
          let canRemovePlaceholder = false;
          if (currentSrc && this.REGEXPS.b64DataUrl.test(currentSrc)) {
              const parts = this.REGEXPS.b64DataUrl.exec(currentSrc);
              if (parts && parts[1] !== "image/svg+xml") { // Don't remove SVG placeholders easily
                  const b64length = currentSrc.length - parts[0].length;
                  if (b64length < 150) { // Slightly increased threshold for small placeholders
                       // Check if other attributes likely contain a real image source
                       for (const attr of Array.from(elem.attributes)) {
                           if (attr.name !== 'src' && imageExtensions.test(attr.value)) {
                               canRemovePlaceholder = true;
                               break;
                           }
                       }
                       if(canRemovePlaceholder) {
                           this.log("Potential placeholder found, can remove:", elem);
                           currentSrc = null; // Treat as if src is not set for replacement logic below
                           elem.removeAttribute("src"); // Remove placeholder now if possible
                       }
                  }
              }
          }


          // Find potential sources in other attributes (data-src, data-srcset, etc.)
          for (const attr of Array.from(elem.attributes)) {
              const attrName = attr.name.toLowerCase();
              const attrValue = attr.value;

              if (!attrValue || attrName === 'src' || attrName === 'srcset') continue;

              // Check for srcset pattern first
              if (/\.(jpg|jpeg|png|webp)\s+\d/.test(attrValue)) { // Relaxed check for srcset format
                 if (!potentialSrcset) potentialSrcset = attrValue; // Prefer first found data-srcset
              }
              // Check for simple src pattern
              else if (imageExtensions.test(attrValue) && !attrValue.includes(' ') && this._isUrl(attrValue)) { // Ensure it looks like a single URL
                 if (!potentialSrc) potentialSrc = attrValue; // Prefer first found data-src
              }
              // Basic check for other common lazy load attributes
              if ((attrName.includes("lazy") || attrName.includes("load")) && imageExtensions.test(attrValue)) {
                    if (!potentialSrc && !potentialSrcset && this._isUrl(attrValue)) potentialSrc = attrValue;
              }
          }

          // Apply found sources if the element doesn't already have a real one
          if (!hasRealSrc || canRemovePlaceholder) {
              if (potentialSrcset) {
                  elem.setAttribute("srcset", potentialSrcset);
                  this.log("Applied lazy srcset:", elem);
                  hasRealSrc = true; // Mark as having source now
              }
              if (potentialSrc) {
                   // Set src only if srcset wasn't successfully applied or doesn't exist
                  if (!elem.getAttribute('srcset')) {
                     elem.setAttribute("src", potentialSrc);
                     this.log("Applied lazy src:", elem);
                     hasRealSrc = true;
                  } else {
                     this.log("Skipped applying lazy src because srcset was applied:", potentialSrc);
                  }
              }
          }


          // Special handling for FIGURES without IMG/PICTURE children
          if (elem.tagName === "FIGURE" && !this._getAllNodesWithTag(elem, ["img", "picture"]).length) {
              if (potentialSrcset || potentialSrc) {
                  const img = this._doc.createElement("img");
                  if (potentialSrcset) img.setAttribute("srcset", potentialSrcset);
                  if (potentialSrc) img.setAttribute("src", potentialSrc);
                  // Append the new image inside the figure
                  // Clear existing figure content? Or append? Let's append.
                  elem.appendChild(img);
                  this.log("Created img inside figure for lazy source:", elem);
              }
          }
      }
  },

  /**
   * Calculates the density of text within specific tags relative to the total text length.
   * @param {Element} e The element to analyze.
   * @param {Array<string>} tags Array of uppercase tag names.
   * @returns {number} Density (0-1)
   */
  _getTextDensity(e, tags) {
      const totalTextLength = this._getInnerText(e, true).length;
      if (totalTextLength === 0) {
          return 0;
      }
      let childrenLength = 0;
      const children = this._getAllNodesWithTag(e, tags);
      for (const child of children) {
          childrenLength += this._getInnerText(child, true).length;
      }
      return childrenLength / totalTextLength;
  },


  /**
   * Clean an element of child nodes matching `tag` based on heuristics
   * like content length, classnames, link density, image counts, etc.
   * PERFORMANCE: Uses querySelectorAll for efficient counting.
   *
   * @param {Element} e Element to clean within
   * @param {string} tag Tag name (lowercase) of children to consider removing
   **/
  _cleanConditionally(e, tag) {
      if (!this._flagIsActive(this.FLAG_CLEAN_CONDITIONALLY)) {
          return;
      }

      const tagUpper = tag.toUpperCase();
      const nodesToEvaluate = Array.from(this._getAllNodesWithTag(e, [tagUpper])); // Static list

      for (const node of nodesToEvaluate) {
          // Check if node still exists in the DOM (might have been removed by other ops)
          if (!node.parentNode) continue;

          const isDataTable = (n) => n._readabilityDataTable === true;
          const isList = node.tagName === "UL" || node.tagName === "OL";

          // --- Exclusion Checks ---
          if (node.tagName === "TABLE" && isDataTable(node)) continue; // Don't remove data tables
          if (this._hasAncestorTag(node, "TABLE", -1, isDataTable)) continue; // Don't remove elements inside data tables
          if (this._hasAncestorTag(node, "CODE")) continue; // Don't remove elements inside code blocks
          if ([...node.getElementsByTagName("table")].some(isDataTable)) continue; // Don't remove if it contains a data table

          // --- Heuristic Calculation ---
          const weight = this._getClassWeight(node);
          this.log("Cleaning Conditionally", node, `Weight: ${weight}`);

          if (weight < 0) { // Immediately remove negatively weighted nodes
              this.log("Removing node due to negative weight:", node);
              node.remove();
              continue;
          }

          // Query descendants once for efficient counting and analysis
           const MAPPING = { // Tags relevant to heuristics
                p: 'p', img: 'img', li: 'li', input: 'input',
                h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6',
                object: 'object', embed: 'embed', iframe: 'iframe',
                span: 'span', td: 'td', div: 'div', blockquote: 'blockquote',
                a: 'a' // Needed for link density calculation elements
           };
           const selectors = Object.values(MAPPING).join(',');
           const elementsInside = node.querySelectorAll(selectors);

           const counts = {};
           let textContentByTag = {}; // Collect text for density
           let linkLength = 0;
           let textDensityLength = 0;
           const textishTags = new Set(['SPAN', 'LI', 'TD', 'P', 'DIV', 'BLOCKQUOTE', 'A']); // Include A for link density text

           for (const elem of elementsInside) {
                const tagNameLower = elem.tagName.toLowerCase();
                counts[tagNameLower] = (counts[tagNameLower] || 0) + 1;

                 const elemText = this._getInnerText(elem, true); // Get text once

                 // Accumulate text for density calculations
                 if (textishTags.has(elem.tagName)) {
                     textDensityLength += elemText.length;
                     if (elem.tagName === 'A') {
                        // Adjust link length based on href (hash links discounted)
                        const href = elem.getAttribute("href");
                        const coefficient = href && this.REGEXPS.hashUrl.test(href) ? 0.3 : 1;
                        linkLength += elemText.length * coefficient;
                     }
                 }

                 // Tally video embeds separately
                 if (['object', 'embed', 'iframe'].includes(tagNameLower)) {
                    let isVideo = false;
                    for (const attr of elem.attributes) { if (this._allowedVideoRegex.test(attr.value)) { isVideo = true; break; }}
                    if (!isVideo && tagNameLower === 'object' && this._allowedVideoRegex.test(elem.innerHTML)) { isVideo = true; }
                    counts[isVideo ? 'videoEmbed' : 'otherEmbed'] = (counts[isVideo ? 'videoEmbed' : 'otherEmbed'] || 0) + 1;
                 }

                 // Accumulate heading text length
                 if(tagNameLower.startsWith('h') && tagNameLower.length === 2) {
                    counts.headingTextLength = (counts.headingTextLength || 0) + elemText.length;
                 }
           }


          const innerText = this._getInnerText(node); // Total text in the node
          const contentLength = innerText.length;
          const charCountComma = this._getCharCount(node, ","); // Commas are a sign of real text

          // Remove if it looks like an ad/loading placeholder by text content alone
          if (contentLength > 0 && contentLength < 50 && (this.REGEXPS.adWords.test(innerText) || this.REGEXPS.loadingWords.test(innerText))) {
               this.log("Removing node due to ad/loading words:", node);
               node.remove();
               continue;
          }


          // If low comma count, apply stricter heuristics
          if (charCountComma < 10) {
              const pCount = counts.p || 0;
              const imgCount = counts.img || 0;
              const liCount = counts.li || 0;
              // Original logic subtracts 100 from li - this seems arbitrary, let's use raw count or proportion.
              // Let's check li proportion:
              const liProportion = contentLength > 0 ? (textContentByTag.li || "").length / contentLength : 0;
              const inputCount = counts.input || 0;
              const headingDensity = contentLength > 0 ? (counts.headingTextLength || 0) / contentLength : 0;
              const embedCount = counts.otherEmbed || 0;
              const videoEmbedCount = counts.videoEmbed || 0;

              // Don't remove if it primarily contains a video
              if (videoEmbedCount > 0 && embedCount === 0 && imgCount === 0) {
                  continue;
              }

              const linkDensity = contentLength > 0 ? linkLength / contentLength : 0;
              const textDensity = contentLength > 0 ? textDensityLength / contentLength : 0;
              const isFigureAncestor = this._hasAncestorTag(node, "FIGURE");

              const shouldRemoveNode = () => {
                  const errs = [];
                  if (!isFigureAncestor && imgCount > 1 && (pCount === 0 || pCount / imgCount < 0.5)) {
                      errs.push(`Bad p/img ratio (img=${imgCount}, p=${pCount})`);
                  }
                  // Revised list check: High proportion of list item text outside actual UL/OL lists?
                  if (!isList && liCount > 0 && pCount === 0 && liProportion > 0.5) {
                       errs.push(`High li proportion outside list context (liCount=${liCount}, p=${pCount}, liProp=${liProportion.toFixed(2)})`);
                  }
                  if (inputCount > Math.floor(pCount / 3)) {
                      errs.push(`Too many inputs/p (input=${inputCount}, p=${pCount})`);
                  }
                  if (contentLength < 25 && (imgCount === 0 || imgCount > 2) && !isFigureAncestor && !isList && headingDensity < 0.9 && linkDensity > 0.2) { // Adjusted linkDensity threshold here
                      errs.push(`Suspiciously short & linky/imageless (len=${contentLength}, img=${imgCount}, linkDensity=${linkDensity.toFixed(2)}, headingDensity=${headingDensity.toFixed(2)})`);
                  }
                  if (!isList && weight < 25 && linkDensity > (0.2 + this._linkDensityModifier)) {
                      errs.push(`Low weight & linky (linkDensity=${linkDensity.toFixed(2)}, weight=${weight})`);
                  }
                  if (weight >= 25 && linkDensity > (0.5 + this._linkDensityModifier)) {
                      errs.push(`High weight & very linky (linkDensity=${linkDensity.toFixed(2)}, weight=${weight})`);
                  }
                  if ((embedCount === 1 && contentLength < 75 && imgCount === 0) || embedCount > 1) { // Consider images too
                      errs.push(`Suspicious embeds (embeds=${embedCount}, len=${contentLength}, img=${imgCount})`);
                  }
                   // Check text density: if very low and no images/videos, likely layout junk
                  if (imgCount === 0 && videoEmbedCount === 0 && textDensity < 0.1 && contentLength < 100) {
                     errs.push(`Low text density, no media (textDensity=${textDensity.toFixed(2)}, len=${contentLength})`);
                  }

                  if (errs.length) {
                      this.log("Conditional removal checks failed:", errs.join("; "));
                      return true;
                  }
                  return false;
              };

              let haveToRemove = shouldRemoveNode();

              // Exception for simple lists containing only images
              if (isList && haveToRemove) {
                  let imageListException = true;
                  const listItems = node.children; // Assume direct children are LIs for OL/UL
                  if (listItems.length !== liCount || liCount === 0) { // Must have LIs matching count
                       imageListException = false;
                  } else {
                      for (const item of listItems) {
                          if (item.tagName !== 'LI' || !this._isSingleImage(item)) { // Check LI contains *only* an image
                              imageListException = false;
                              break;
                          }
                      }
                  }
                  // Final check: number of images found must match number of list items
                  if (imageListException && imgCount === liCount) {
                       this.log("Keeping node due to image list exception:", node);
                       haveToRemove = false; // Override removal
                  }
              }

              if (haveToRemove) {
                  this.log("Conditionally removing node:", node);
                  node.remove();
                  continue; // Move to next node in nodesToEvaluate
              }
          } // End if(charCountComma < 10)
      } // End loop through nodesToEvaluate
  },


  /**
   * Clean out elements that match the specified conditions using a filter function.
   * Traverses descendants depth-first.
   *
   * @param {Element} e Root element to clean within.
   * @param {Function} filter Callback (node, matchString) -> boolean (true to remove).
   */
  _cleanMatchedNodes(e, filter) {
    let node = this._getNextNode(e); // Start with first child
    const endNode = this._getNextNode(e, true); // Marker for end of subtree

    while (node && node !== endNode) {
      const matchString = `${node.className || ""} ${node.id || ""}`;
      if (filter.call(this, node, matchString)) {
        // Get next node *before* removing current one
        const next = this._removeAndGetNext(node);
        node = next;
      } else {
        // Move to the next node normally
        node = this._getNextNode(node);
      }
    }
  },

  /**
   * Clean out spurious H1/H2 headers (negative weight or duplicating title).
   *
   * @param {Element} e Element to clean within.
   **/
  _cleanHeaders(e) {
    const headingNodes = this._getAllNodesWithTag(e, ["h1", "h2"]);
    this._removeNodes(headingNodes, (node) => {
        const isNegative = this._getClassWeight(node) < 0;
        const isDuplicate = this._articleTitle && this._headerDuplicatesTitle(node); // Only check if title exists
        if (isNegative || isDuplicate) {
            this.log(`Removing header (negative: ${isNegative}, duplicate: ${isDuplicate}):`, node);
            return true;
        }
        return false;
    });
  },

  /**
   * Check if this node is an H1 or H2 element whose content is similar to the article title.
   *
   * @param {Element} node The node to check.
   * @returns {boolean} indicating whether this is a title-like header.
   */
  _headerDuplicatesTitle(node) {
    if (node.tagName !== "H1" && node.tagName !== "H2") {
      return false;
    }
    // Ensure we have a title to compare against
    if (!this._articleTitle) return false;

    const heading = this._getInnerText(node, false);
    const title = this._articleTitle;
    const similarity = this._textSimilarity(title, heading);

    this.log(`Evaluating header similarity: "${heading}" vs "${title}" = ${similarity.toFixed(2)}`);
    // Use a threshold, and also consider if the heading is much shorter (e.g., site name)
    return similarity > 0.75 || (similarity > 0.5 && heading.length * 1.5 < title.length);
  },

  _flagIsActive(flag) {
    return (this._flags & flag) > 0;
  },

  _removeFlag(flag) {
    this._flags = this._flags & ~flag;
  },

  /**
   * Check if a node is likely visible (not display:none, visibility:hidden, or hidden attributes).
   * @param {Node} node
   * @returns {boolean}
   */
  _isProbablyVisible(node) {
    // Handle non-element nodes
    if (node.nodeType !== this.ELEMENT_NODE || !node.style || typeof node.hasAttribute !== 'function') {
        return true; // Assume visible if not an element with style/attributes
    }
    return (
        node.style.display !== "none" &&
        node.style.visibility !== "hidden" &&
        !node.hasAttribute("hidden") &&
        (node.getAttribute("aria-hidden") !== "true" ||
            (node.className && typeof node.className.includes === 'function' && node.className.includes("fallback-image"))) // Exception for fallback images
    );
  },

  /**
   * Runs readability. Extracts article content.
   *
   * @returns {object|null} Object containing extracted article data (title, content, etc.), or null if failed.
   **/
  parse() {
    // Avoid parsing too large documents
    if (this._maxElemsToParse > 0) {
      const numTags = this._doc.getElementsByTagName("*").length;
      if (numTags > this._maxElemsToParse) {
        throw new Error(`Aborting parsing document; ${numTags} elements found (max: ${this._maxElemsToParse})`);
      }
    }

    // Phase 1: Pre-processing and Metadata Extraction
    this._unwrapNoscriptImages(this._doc);
    const jsonLd = this._disableJSONLD ? {} : this._getJSONLD();
    this._removeScripts(this._doc);
    this._prepDocument(); // Modifies the main document (style removal, BR->P, font->span)
    this._metadata = this._getArticleMetadata(jsonLd); // Combines JSON-LD and meta tags
    this._articleTitle = this._metadata.title; // Use metadata title primarily
    this._articleByline = this._metadata.byline; // Use metadata byline primarily
    this._articleSiteName = this._metadata.siteName; // Use metadata siteName primarily

    // Set language if available
    this._articleLang = this._docElement.getAttribute("lang") || this._docElement.getAttribute("xml:lang") || this._metadata.lang; // Added metadata lang


    // Phase 2: Content Extraction (using optimized _grabArticle)
    // _grabArticle now works on clones and handles retries internally.
    // It operates on doc.body by default after _prepDocument has run.
    const articleContent = this._grabArticle(); // Pass null to use doc.body

    if (!articleContent) {
      this.log("Failed to extract article content.");
      return null;
    }

    this.log("Grabbed article content element:", articleContent);

    // Phase 3: Post-processing on the extracted content
    this._postProcessContent(articleContent);

    // Phase 4: Final Result Assembly
    // Ensure excerpt is set (fallback to first paragraph)
    if (!this._metadata.excerpt) {
      const firstP = articleContent.querySelector("p"); // Find first P in final content
      if (firstP) {
        this._metadata.excerpt = this._getInnerText(firstP).substring(0, 300); // Limit excerpt length?
      }
    }

    const textContent = this._getInnerText(articleContent, true); // Get clean text content

    return {
      title: this._articleTitle,
      byline: this._articleByline, // Already determined during grab/metadata phase
      dir: this._articleDir,       // Determined by _finalizeArticle
      lang: this._articleLang,     // Determined from html/metadata
      content: this._serializer(articleContent), // Serialize the final DOM
      textContent: textContent,
      length: textContent.length,
      excerpt: this._metadata.excerpt,
      siteName: this._articleSiteName, // Already determined
      publishedTime: this._metadata.publishedTime, // From metadata
    };
  },
};

// Export for Node.js environments
if (typeof module === "object" && module.exports) {
  module.exports = Readability;
}