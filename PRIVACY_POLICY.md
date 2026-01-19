# Privacy Policy - ANDI for Chrome

**Last Updated: January 19, 2026**

## Overview

ANDI for Chrome ("the Extension") is committed to protecting your privacy. This Privacy Policy explains how the Extension handles your information.

## Data Collection

**The ANDI for Chrome extension does NOT collect, store, transmit, or retain any personal data or user information.**

### What the Extension Does:

- **Local Analysis Only**: ANDI analyzes the HTML and accessibility attributes of web pages you visit solely within your browser
- **No Data Transmission**: All analysis is performed locally on your device. No data is sent to external servers, APIs, or third parties
- **No Storage**: The extension does not store any information about the pages you analyze or the results of those analyses
- **No Tracking**: The extension does not track your browsing activity or use analytics

### What Data the Extension Can Access:

As a content script, ANDI has access to:
- The DOM and HTML structure of pages where you activate it
- Page accessibility attributes (ARIA roles, labels, descriptions, etc.)

This information is used **only** for the current analysis session and is never stored, logged, or transmitted.

## Permissions

ANDI for Chrome requires only two permissions:

1. **`activeTab`**: Allows ANDI to run on the currently active tab when you click the extension button
2. **`scripting`**: Allows ANDI to inject its analysis code into the page to examine accessibility

These permissions are used strictly for the purpose of analyzing accessibility and are not used for any other purpose.

## Chrome Web Store

This extension is distributed through the Chrome Web Store. Google may collect metadata about extension installation and usage through their standard mechanisms, which is outside the control of this extension. Please refer to [Google's Privacy Policy](https://policies.google.com/privacy) for more information.

## Changes to This Policy

We may update this Privacy Policy from time to time. Any changes will be posted on this page with an updated "Last Updated" date.

## Questions

If you have any questions about this Privacy Policy or the extension's practices, you can:
- Visit the [ANDI for Chrome GitHub Repository](https://github.com/coreymoore/ANDI-for-Chrome)

---

**Summary**: ANDI for Chrome analyzes web pages locally in your browser for accessibility issues. It does not collect, store, transmit, or retain any data. All analysis is performed on your device and is never shared with anyone.
