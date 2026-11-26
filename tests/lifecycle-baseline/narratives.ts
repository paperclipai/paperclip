export const narratives = [
  ["neutral", "Work recorded."],
  ["no-approval", "No approval required. I will inspect the repository."],
  [
    "scoped-negation",
    "I am not blocked on setup, but board approval is required. I will implement after approval.",
  ],
  [
    "historical-quote",
    'The old log says "waiting on access". I will inspect the repository.',
  ],
  ["spanish", "Voy a revisar el repositorio y ejecutar las pruebas."],
  ["optional-next-steps", "Next steps: inspect optional future improvements."],
  ["all-done", "All done."],
  ["keep-going", "Keep going. I will implement the next change."],
  ["empty", ""],
] as const;
