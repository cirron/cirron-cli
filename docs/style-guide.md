# TypeScript style guide

We follow the [Google TypeScript Style Guide, Comments and
documentation](https://google.github.io/styleguide/tsguide.html#comments-and-documentation).
`ultracite` / `biome` enforces the mechanical half (`npm run lint`); the rest is
review.

The reference is scoped to that section deliberately. Google's other chapters —
`const enum`, `namespace`, visibility modifiers, array type syntax — have never
been audited against this codebase, and declaring conformance we cannot back
would be worse than declaring none.

## Prose

Complete sentences with proper punctuation, in JSDoc and comments alike.
Write the *why*. State the *what* only where the code's intent isn't recoverable
from naming: a dense expression, a non-obvious protocol step, an ordering
constraint. Delete anything that merely renames the next line.

## Comments

- **One line, or a trailer on the code line.** Two lines are acceptable when
  short and to the point. Anything longer belongs in JSDoc — that is the
  house rule, and the main place we diverge from Google, which sets no length
  cap and in fact *requires* multi-line comments to use repeated `//` rather
  than `/* */`.
- **Section markers are fine.** A one-line `//` breaking up a long function
  earns its place even when it partly restates the code beneath it. What does
  not is a comment sitting above a single self-describing call.
- **No boxed banners.** Not this:

  ```ts
  // -------------------
  // -- Service calls --
  // -------------------
  ```

- **Top-level `//` file headers are fine.** JSDoc is not required for module
  headers; Google's own published packages use a `//` block on every file.
- Keep every `biome-ignore` and every `TODO`.
- Keep measured results, especially negative ones, correctness invariants,
  ordering constraints, and upstream-bug workarounds — anything a reader would
  otherwise "fix" and thereby break.
- No internal references in source comments. This package publishes its
  TypeScript source to npm, so ticket IDs, sibling-repo paths, planning
  documents and platform-internal model names are all public. A CI grep for
  these is cheap and worth adding.

## JSDoc

JSDoc describes structure and may run as long as it needs to.

- Every exported function and method gets a summary, plus `@param <name> -
  <description>` and `@returns`. This is what puts text in editor hover and
  signature help.
- **Never annotate types in tags.** The braces are a pre-TypeScript holdover
  from when the comment was the only place a type could live:

  ```ts
  @param {object} [options] - The configuration object.   // no
  @param options - The configuration object.              // yes
  ```

  The signature already declares the type; repeating it duplicates something
  that drifts silently when the signature changes, and tells editors nothing
  they don't already know. Note that Google's own generated API clients do
  annotate types — those are emitted for JavaScript consumers and diverge from
  Google's guide on exactly this point. Don't imitate them.
- Document `@throws` where a caller has to handle it.
- Document only verified behavior. Read the function before writing its doc; a
  wrong doc is worse than none.
- Small functions and attributes may use a single-line `/** ... */`.

## Tests

Test files may be more verbose. The test *name* is the spec, so make it long and
descriptive. Add prose for rationale a reader cannot recover from the code: why
this ordering, why the test is not vacuous, what a naive version would fail to
prove.

A regression test should be checked against the unfixed code. One that passes
either way documents nothing.

## Related

- `CONTRIBUTING.md` — contribution workflow and the rest of the style rules.
- `../cirron-sdk/docs/style-guide.md` — the Python counterpart, which defers to
  Google's Python guide §3.8 the same way. It caps standalone comment blocks at
  four lines where this guide caps inline comments at two; the two repos differ
  deliberately.
