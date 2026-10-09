# Prompt changelog

Prompts are versioned by filename (`<name>.vN.md`). Never edit a released version in place: copy to `vN+1`, change
`prompts:` in `config.yaml`, re-run `npm run eval`, and record why here. Every call record stores the prompt versions used.

## v1 (initial)
- conversation.v1: phone persona, intake order, running rubric assessment, hard "never" list, JSON turn contract.
- classifier.v1: five-criteria extraction (facts + verdicts); tier decided by `src/rules.js`, not by the model.

## conversation v2
- Why: first live Gemini run (2026-10-09) answered a Hinglish caller in English and reported language "en".
- Change: STATE now carries `reply_language` (decided by code from the caller's words); the prompt makes it mandatory and gives Hinglish examples.
  Engine also falls back to its Hinglish templates if the model ignores it. v1 is kept unchanged for reference.
- Note: recorded conversation fixtures were produced against v1; the recorded eval does not depend on prompt text. The live Gemini eval is the real test of v2.
