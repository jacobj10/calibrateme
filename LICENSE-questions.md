# Question bank license & attribution

The trivia question bank embedded in `index.html` (the `QUESTION_BANK` array) is
a **separate work** from the application code and is distributed under a
different license than the MIT-licensed code (see `LICENSE`).

## License

The question bank is licensed under the **Creative Commons
Attribution-ShareAlike 4.0 International License (CC BY-SA 4.0)**.

Full license text: https://creativecommons.org/licenses/by-sa/4.0/

This means anyone may use, share, and adapt the bank — including commercially —
provided they (a) give attribution as below, and (b) distribute any adaptations
of it under CC BY-SA 4.0 as well (ShareAlike).

## Attribution

A majority of the questions are derived from the **Open Trivia Database**
(https://opentdb.com), whose contributed questions are licensed under CC BY-SA
4.0.

## Modifications

The bank is **modified** from the Open Trivia Database source. Changes include:

- Decoded HTML entities to plain Unicode text.
- Removed questions with time-drifting phrasing ("currently", "as of", live
  records) so every answer is a stable fact.
- De-duplicated by normalized question text and removed items with duplicate or
  ambiguous options.
- Rebalanced across eight categories and an easy/medium/hard difficulty spread;
  capped over-represented categories.
- Reshuffled answer positions so the correct option is not positionally biased.
- Reformatted into `{id, category, difficulty, question, options, answerIndex}`.

Approximately 230 additional questions (the *food & drink* and *words & language*
categories, and part of the *hard* tier) are **original, hand-written** work by
this project's authors, not from the Open Trivia Database. By combining them into
this single bank and distributing it under CC BY-SA 4.0, those original questions
are also offered under CC BY-SA 4.0.
