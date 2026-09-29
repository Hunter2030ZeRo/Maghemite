export const TOKEN = "item";
export const MAIN_PATH = "main.fixture";
export const TARGET_PATH = "target.fixture";
export const GATE_PATH = "gate.fixture";
export const IMPORT_TEXT = 'use "target.fixture"\r\n';

export const MAIN_TEXT = "// 프로젝트 😀\r\n\r\nitem\r\n";
export const TARGET_TEXT = "// définition Ω\r\ndeclare item\r\n";

export const projectLanguageFixture = {
  protocol: 2,
  scope: "project",
  token: TOKEN,
  main: { path: MAIN_PATH, text: MAIN_TEXT },
  target: { path: TARGET_PATH, text: TARGET_TEXT },
  importText: IMPORT_TEXT,
  gatePath: GATE_PATH,
} as const;
