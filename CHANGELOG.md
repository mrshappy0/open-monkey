## [1.3.1](https://github.com/mrshappy0/open-monkey/compare/v1.3.0...v1.3.1) (2026-05-23)


### Bug Fixes

* override uuid>=11.1.1 and qs>=6.15.2 to resolve moderate CVEs ([#21](https://github.com/mrshappy0/open-monkey/issues/21)) ([7c03a0c](https://github.com/mrshappy0/open-monkey/commit/7c03a0c0a0a1cbeca7f9aa62a005b9f9d75f04dc))

# [1.3.0](https://github.com/mrshappy0/open-monkey/compare/v1.2.0...v1.3.0) (2026-05-16)


### Features

* CodeMirror 6 editor with syntax highlighting and full-screen tab ([#14](https://github.com/mrshappy0/open-monkey/issues/14)) ([cadde6d](https://github.com/mrshappy0/open-monkey/commit/cadde6de36e0002dbe55cd76587750e48f55b9f2))

# [1.2.0](https://github.com/mrshappy0/open-monkey/compare/v1.1.0...v1.2.0) (2026-05-15)


### Features

* Chrome sync toggle with chunking for large scripts ([#13](https://github.com/mrshappy0/open-monkey/issues/13)) ([6d79755](https://github.com/mrshappy0/open-monkey/commit/6d797551ce72c925240e945f733b7de25a123ebd))

# [1.1.0](https://github.com/mrshappy0/open-monkey/compare/v1.0.0...v1.1.0) (2026-05-15)


### Features

* general-purpose script store with GM_getValue/GM_setValues API ([#12](https://github.com/mrshappy0/open-monkey/issues/12)) ([9f5f22d](https://github.com/mrshappy0/open-monkey/commit/9f5f22d654a17d99d7ddca71255a47bed86b89d7))

# 1.0.0 (2026-05-15)


### Bug Fixes

* bump react-dom to 19.2.6 to match react ([c1b6ee6](https://github.com/mrshappy0/open-monkey/commit/c1b6ee639fb40ae9852b4d9a4c02884aff89f5ea))
* pin ip-address >=10.2.0 via pnpm override; add .gitattributes LF normalization ([ee18db7](https://github.com/mrshappy0/open-monkey/commit/ee18db70c3fb104aea81d17a67a9ccc2e09ce522))
* update Unraid URL references in documentation and user scripts ([3fb7a23](https://github.com/mrshappy0/open-monkey/commit/3fb7a23957c99307ea604263ade73e8b64f1cf56))
* use GH_TOKEN (PAT) for semantic-release to bypass branch protection ([#11](https://github.com/mrshappy0/open-monkey/issues/11)) ([ff01b14](https://github.com/mrshappy0/open-monkey/commit/ff01b14c42df66839f454b2a3a8926fd1cc10423))


### Features

* add @types/chrome to devDependencies ([c577359](https://github.com/mrshappy0/open-monkey/commit/c5773596c03a95804e9339d719e85b9f4e8ab4f5))
* add comprehensive GitHub Copilot instructions and project documentation ([2590421](https://github.com/mrshappy0/open-monkey/commit/2590421154c01cd9c6e9767f352ff4c6da535a73))
* add OpenAI-compatible API provider mode to ask-page ([77493e0](https://github.com/mrshappy0/open-monkey/commit/77493e0a26e032cb5eb92e81e0fd5398443a9428))
* ask-page Ollama userscript + EADDRINUSE auto-retry in native host ([61cb0bf](https://github.com/mrshappy0/open-monkey/commit/61cb0bff6c43eb79e4cdf04a2f996199417e2918))
* auto-reload active tab on script toggle, fix retry-guard reset ([bccc45c](https://github.com/mrshappy0/open-monkey/commit/bccc45c4ab44366d862432fb67065f0224704b81))
* CI/CD with semantic-release, ESLint, commitlint, and monkey emoji icons ([#10](https://github.com/mrshappy0/open-monkey/issues/10)) ([c51ff23](https://github.com/mrshappy0/open-monkey/commit/c51ff232a812524aac1c6e6ef20505e1a4774387))
* implement logger utility for improved debugging ([ee46027](https://github.com/mrshappy0/open-monkey/commit/ee460271b53eb5c87ff0d634457b2b9cef306480))
* implement max retries for user scripts and add settings UI ([3cc9bce](https://github.com/mrshappy0/open-monkey/commit/3cc9bce3b3ded04ea817baccf344a6ca96575a0f))
* initial OpenMonkey scaffold ([9bd7c13](https://github.com/mrshappy0/open-monkey/commit/9bd7c13ee338ead75638c3b9da3aadd2b85ffa85))
* remove startUrls configuration from web-ext.config.ts ([fb649fa](https://github.com/mrshappy0/open-monkey/commit/fb649fa16c7c12c266f51aa4628513eb1e60a44c))
* route API calls through background proxy to bypass CORS ([cdc8cd0](https://github.com/mrshappy0/open-monkey/commit/cdc8cd0ea20357421faa4c1cc159498a69a086b1))
* seed built-in scripts from dev-scripts/*.user.js via ?raw imports ([6890c2b](https://github.com/mrshappy0/open-monkey/commit/6890c2b0ccdca7242b386c5e91a314bad18cbad7))
