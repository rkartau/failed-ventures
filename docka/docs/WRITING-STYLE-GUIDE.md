# Docka writing style guide

Applies to every marketing page, guide, blog post and FAQ on docka.me. Goal: text that reads as written by a person who works with STCW paperwork every day, not by a language model. Source for the banned list: Wikipedia, "Signs of AI writing" (https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing), plus Docka's own house rules. Last updated: 6 September 2026.

## 1. Banned patterns

Each line: the rule, then a bad and a good example. One hit may be a coincidence; a cluster is a fail.

**Punctuation and characters**
- No em dashes (U+2014) or en dashes used as dashes (U+2013). Use a comma, a full stop or brackets. Bad: "The date is a claim [em dash] the register is proof." Good: "The date is a claim. The register is proof."
- Straight quotes and apostrophes only (" and '). No curly quotes (U+201C, U+201D, U+2018, U+2019). Bad: the word valid wrapped in typographic (curly) quotes. Good: wrapped in straight quotes.
- Hyphen for ranges in prose ("2017-2025") or the word "to". No Unicode ranges.
- No emoji, ever, including as bullets or section markers.
- No horizontal rules (---) between sections. Headings do the separating.

**Vocabulary (delete on sight)**
- Banned words: delve, crucial, pivotal, robust, seamless, seamlessly, landscape, tapestry, testament, navigate (figurative), leverage (verb), harness, unlock, elevate, empower, streamline, cutting-edge, game-changer, game-changing, groundbreaking, vibrant, boasts, bolster, intricate, interplay, meticulous, underscore, foster, showcase, garner, enduring, ever-evolving, holistic, synergy, journey (figurative), realm, dynamic (adjective), comprehensive, transformative, revolutionise. Bad: "Docka leverages robust registry integrations." Good: "Docka queries eight flag-state registers directly."
- No "-ing" tails that fake analysis: "highlighting", "underscoring", "reflecting", "emphasising", "showcasing", "contributing to". Bad: "...issued in 2017, highlighting Bulgaria's commitment." Good: "...issued in 2017." Stop there.
- Use "is", "are", "has". Not "serves as", "stands as", "functions as", "represents", "features", "offers" as copula substitutes. Bad: "The register serves as the source of truth." Good: "The register is the source of truth."
- No vague attribution: "experts say", "industry reports suggest", "observers note", "it is widely recognised". Name the source or cut the claim. Bad: "Experts agree PSC inspectors check registers." Good: "Paris MoU inspection guidance (link) asks inspectors to check the register."
- No "in connection with" / "associated with" when you mean a plain verb. Bad: "a certificate associated with a suspension". Good: "a suspended certificate".
- No promotional filler: "nestled", "rich", "in the heart of", "world-class", "state-of-the-art", "trusted by thousands", "best-in-class".

**Sentence patterns**
- No "not only X but also Y", "not just X, it's Y", "this isn't X, it's Y". Say the one thing that matters. Bad: "This is not just a check, it's peace of mind." Good: "This is a check against the register."
- No "X rather than Y" used as a rhetorical correction of a misconception nobody held. Fine when it states a real choice ("we query the register rather than the PDF").
- No rule-of-three padding. If there are two reasons, list two. If there are five, list five. Bad: "fast, reliable and secure". Good: "answers in about 4 seconds" (or say nothing).
- No false ranges: "from small agencies to global fleets", "from cadets to captains".
- No "In today's fast-paced world", "In the world of maritime", "In an era of", "As the industry evolves".
- No hedging tics: "It's important to note", "It's worth noting", "Notably", "Importantly", "Interestingly", "Essentially", "Ultimately". Delete the phrase; keep the fact.
- No "Additionally", "Furthermore", "Moreover" as glue.
- No "In conclusion", "In summary", "Overall", "To sum up", "Final thoughts". A guide ends when the last useful sentence ends, then the CTA.
- No "Despite X, Y faces challenges" or "Challenges and future outlook" sections.
- No knowledge-cutoff language: "as of my last update", "as of 2024", "at the time of writing" without a real date. Write the date: "checked 6 September 2026".
- No chatbot residue: "Great question", "Certainly", "I hope this helps", "Let's dive in", "Please note".
- No section that restates the section above it.

**Structure and formatting**
- No heading per paragraph. A heading needs at least two paragraphs, a list or a table below it.
- No parent heading whose only content is sub-headings.
- No skipped heading levels (H2 to H4). No Title Case in headings; sentence case only.
- No bold on every noun. Bold at most one phrase per section, and only when a reader scanning for it would thank you.
- No "inline header then list" pattern ("Key benefits:" followed by five bullets that are each a sentence fragment). Lists are for steps, registries, or genuinely parallel items.
- No tables for things that are not tabular.
- No Markdown artefacts in HTML output (stray "**", "##", "---").
- No generic FAQ filler ("What is STCW?" answered in two sentences to hit a schema quota). Each FAQ must answer a question someone would actually type, with a fact that is not already in the body.
- No "Awards and recognition" vanity sections or "featured in prominent media outlets".
- No placeholders ("[insert registry]", "Lorem", "TBD") and no tracking parameters (utm_source) in reference links.

**Things that are fine and encouraged**
- First person plural with a real opinion: "We think the printed expiry date is worthless as evidence."
- Plain admissions of uncertainty: "We do not know why the Cyprus portal returns 'pending' for some 2019 issues."
- Sentence-length variation. Some sentences are four words. Others run longer because the thought needs it.
- Specific numbers, names, dates, registry names and URLs.
- Contractions where a person would use them ("doesn't", "isn't").

## 2. Docka voice (10 rules)

1. Write for three readers: a crewing manager with 40 seafarers rotating this month, a seafarer checking their own status, and a PSC inspector who wants the register answer, not the PDF. Say which one you are talking to when it matters.
2. Name the registry. "The Danish Maritime Authority (Søfartsstyrelsen)", not "the relevant authority". Use the local name once, then the English name.
3. State what Docka cannot do, in the same paragraph as what it can. Bulgaria is a presence check, not a validity verdict. Ukraine's state registry covers 2023 onward. Say it.
4. Short sentences carry the point. One idea per sentence for anything a reader might act on.
5. British spelling and international English: "licence" (noun), "organisation", "verify", "programme", "centre". Avoid US idiom ("reach out", "gotten").
6. No marketing superlatives. No "best", "leading", "trusted", "world-class". Replace with a number or delete.
7. Cite the authority, not the vibe. Link the register, the IMO or STCW text, the Paris MoU or Tokyo MoU document. One primary source beats three blog posts.
8. Dates as "6 September 2026". Money as "300 EUR / month", "2 EUR per seafarer". No "$" and no "€" glyph in body text.
9. Terminology: STCW, CoC (certificate of competency), CoP (certificate of proficiency), GMDSS, flag state, PSC, MoU, IMO number, registry / register (either, but be consistent within a page). Expand the acronym on first use.
10. Trust-level language is fixed: L0 Unverified, L1 Reviewed by staff, L2 Registry-confirmed, L3 Government-verified. Never round a lower level up in prose.

## 3. Structure rules for a Docka guide

- The first two sentences answer the search query directly. Example opener that works: "The short answer: do not trust the expiry date printed on the document. Check the certificate against the flag state's live register."
- Byline and "Last updated: 6 September 2026" under the H1. The byline is "Docka Development OÜ, Tallinn" or a named person.
- One H2 per real sub-question a reader has. Typical guide: 4 to 6 H2s. No H2 that exists only for a keyword.
- Steps as a numbered list; registries as a bulleted list with the authority name; trust levels as a table. Everything else is prose.
- Length: 900 to 1,500 words for a guide. Blog posts 600 to 1,200. If it needs more, split it.
- One boxed CTA at the end of the body, before sources. Pick one action: verify a certificate, see registry coverage, or book a call. Not all three.
- Sources list at the end with real, resolving URLs to the authority or the IMO/MoU document. No book citations without page numbers. Check every link before submitting.
- Do not append a "How we verify" section. Link to /resources/how-seafarer-certificate-verification-works and /about instead. Registry caveats (Cyprus, Ukraine, Bulgaria) may be mentioned inline where they affect the answer, in one sentence each.
- Internal links: 2 to 4 per guide, in running text, with descriptive anchor text ("registry coverage page", not "click here").
- FAQ block only if it adds facts not in the body. Three questions maximum.

## 4. Self-check before submitting

Run this on your own draft. All twelve must pass.

1. Do the first two sentences answer the query without preamble?
2. Search the draft for U+2014, U+2013, U+201C, U+201D, U+2018, U+2019. Zero hits?
3. Run the banned-word regex below. Zero hits, or each remaining hit justified in a comment?
4. Is every heading followed by real content, in sentence case, with no skipped levels?
5. Is there any list of exactly three adjectives or benefits? Cut or make it honest.
6. Does every claim about a registry name the authority and say the coverage limit?
7. Is there at least one sentence that says what Docka does not do?
8. Are all dates written as "6 September 2026" and all money as "300 EUR"?
9. Are there real numbers (count of registries, year thresholds, fee, time) rather than "many", "several", "fast"?
10. Read it aloud. Do any two consecutive sentences have the same length and shape? Rewrite one.
11. Does the piece end on a useful sentence followed by one CTA, with no summary paragraph?
12. Do all source URLs resolve, and is there no utm_ parameter, placeholder or Markdown artefact?

**Mechanical scan (regex, case-insensitive, run with grep -P or rg)**

```
[\x{2014}\x{2013}\x{201C}\x{201D}\x{2018}\x{2019}]
\b(delve|delving|crucial|pivotal|robust|seamless(ly)?|landscape|tapestry|testament|navigat(e|ing)|leverag(e|ing)|harness(es|ing)?|unlock(s|ing)?|elevat(e|ing)|empower(s|ing)?|streamlin(e|ing)|cutting-edge|game-?chang(er|ing)|groundbreaking|vibrant|boasts?|bolster(s|ed|ing)?|intricate|interplay|meticulous(ly)?|underscor(e|es|ing)|foster(s|ing)?|showcas(e|es|ing)|garner(s|ed)?|enduring|ever-evolving|holistic|synergy|realm|transformative|revolutioni[sz]e)\b
\b(highlighting|underscoring|emphasi[sz]ing|reflecting|symboli[sz]ing|contributing to)\b
\b(serves as|stands as|functions as|operates as|represents a)\b
\b(not only|not just|isn't just|is not just|rather than|more than just)\b
\b(in conclusion|in summary|to sum up|overall,|final thoughts|ultimately)\b
\b(it'?s (important|worth) (to note|noting)|notably|importantly|interestingly|essentially|additionally|furthermore|moreover)\b
\b(whether you'?re|in today'?s|in the world of|in an era of|in the (ever-)?evolving|fast-paced)\b
\b(great question|certainly|i hope this helps|let'?s dive|please note|as of my last|at the time of writing|as an ai)\b
\b(experts (say|agree|argue)|industry reports|observers (note|have)|widely (recogni[sz]ed|regarded)|some critics)\b
\b(world-class|state-of-the-art|best-in-class|trusted by|leading provider|nestled|in the heart of)\b
(\*\*|^#{1,6} |^---$|utm_source=|\[insert|lorem ipsum|TBD)
```

A hit is not automatically a fail for "rather than", "represents", "certainly" or "overall" in ordinary use; a reviewer decides. Every other line is a straight delete-and-rewrite.

## 5. Two paragraphs to calibrate against

Bad (AI-shaped): "In today's fast-paced maritime landscape, ensuring compliance is crucial. Docka leverages cutting-edge technology to seamlessly verify certificates, not only saving time, but also providing peace of mind. It's important to note that verification is a journey, not a destination."

Good (Docka): "A certificate is a copy. The authority's register is the original record. Docka checks the certificate number against that register for eight flag states (Estonia, Denmark, Cyprus, the UK, Norway, France, Ukraine and Azerbaijan). For Bulgaria the check only confirms the document exists. For everyone else, we take you to the official portal and a person finishes the check."
