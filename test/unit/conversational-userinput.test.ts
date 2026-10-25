import { describe, expect, test } from "bun:test";
import {
  UserInputExchange,
  isMultiSelectQuestion,
  matchConversationalChoice,
  renderConversationalQuestionPrompt,
  validUserInputAnswers,
} from "../../src/msp/user-input.js";

const COLOR_QUESTION = {
  id: "q-color",
  header: "Pick a color",
  question: "Which color should the banner use?",
  options: [
    { label: "Blue", description: "Calm and corporate" },
    { label: "Red" },
    { label: "Cyan", description: "Bright accent" },
  ],
};

describe("Conversational userInput rendering", () => {
  test("userInput.rendersHeaderQuestionAndLetteredOptions", () => {
    const text = renderConversationalQuestionPrompt({ question: COLOR_QUESTION, attempt: 0 });
    expect(text).toContain("opencode-muse bridge message");
    expect(text).toContain("Pick a color");
    expect(text).toContain("Which color should the banner use?");
    expect(text).toContain("A. Blue");
    expect(text).toContain("Calm and corporate");
    expect(text).toContain("B. Red");
    expect(text).toContain("Reply with one option");
  });

  test("userInput.restatesOnReask", () => {
    const text = renderConversationalQuestionPrompt({ question: COLOR_QUESTION, attempt: 1, received: "teal" });
    expect(text).toContain("teal");
    expect(text).toContain("A. Blue");
  });
});

describe("Conversational userInput matching", () => {
  test("userInput.matchesLetterNumberAndName", () => {
    expect(matchConversationalChoice(COLOR_QUESTION.options, "b")?.label).toBe("Red");
    expect(matchConversationalChoice(COLOR_QUESTION.options, "3")?.label).toBe("Cyan");
    expect(matchConversationalChoice(COLOR_QUESTION.options, "C Cyan")?.label).toBe("Cyan");
    expect(matchConversationalChoice(COLOR_QUESTION.options, "yes") ?? null).toBeNull();
    expect(matchConversationalChoice(COLOR_QUESTION.options, "Yellow") ?? null).toBeNull();
  });

  test("userInput.detectsMultiSelect", () => {
    expect(isMultiSelectQuestion({})).toBe(false);
    expect(isMultiSelectQuestion({ mode: "single" })).toBe(false);
    expect(isMultiSelectQuestion({ mode: "multiple" })).toBe(true);
    expect(isMultiSelectQuestion({ mode: "Multiple" })).toBe(true);
    expect(isMultiSelectQuestion({ maxSelections: 3 })).toBe(true);
    expect(isMultiSelectQuestion({ maxSelections: 1 })).toBe(false);
  });
});

describe("Conversational userInput validation", () => {
  const questions = [COLOR_QUESTION];
  test("userInput.acceptsExactOfferedLabels", () => {
    expect(validUserInputAnswers(questions, [{ questionId: "q-color", selectedLabel: "Blue" }])).toBe(true);
  });

  test("userInput.rejectsInventedLabelsUnknownQuestionsAndEmpties", () => {
    expect(validUserInputAnswers(questions, [{ questionId: "q-color", selectedLabel: "Teal" }])).toBe(false);
    expect(validUserInputAnswers(questions, [{ questionId: "q-nope", selectedLabel: "Blue" }])).toBe(false);
    expect(validUserInputAnswers(questions, [])).toBe(false);
    expect(validUserInputAnswers(questions, [{ questionId: "q-color" }])).toBe(false);
    expect(validUserInputAnswers(questions, [
      { questionId: "q-color", selectedLabels: ["Blue", "Blue"] },
    ])).toBe(false);
    expect(validUserInputAnswers(questions, [
      { questionId: "q-color", selectedLabels: ["Blue", "Teal"] },
    ])).toBe(false);
  });
});

describe("Conversational userInput exchange", () => {
  function params(userInputId = "ui_1") {
    return {
      userInputId,
      sessionId: "ses_muse_1",
      turnId: "turn_1",
      toolCallId: "call_1",
      toolName: "shell",
      itemId: "item_1",
      viewCursor: "head-1",
      questions: [COLOR_QUESTION],
    };
  }

  test("userInput.tracksAnswerAndAttempts", async () => {
    const exchange = new UserInputExchange({ timeoutMs: 50 });
    expect(exchange.noteVerdictAttempt("missing")).toBe(-1);
    const pending = exchange.requestUserInput(params());
    expect(exchange.noteVerdictAttempt("ui_1")).toBe(0);
    expect(exchange.noteVerdictAttempt("ui_1")).toBe(1);
    expect(exchange.settleAnswer("ui_1", [{ questionId: "q-color", selectedLabel: "Blue" }])).toBe(true);
    const verdict = await pending;
    expect(verdict).toMatchObject({ answers: [{ questionId: "q-color", selectedLabel: "Blue" }] });
    expect(exchange.settleAnswer("ui_1", [])).toBe(false);
  });

  test("userInput.describesPendingInOrder", () => {
    const exchange = new UserInputExchange({ timeoutMs: 50 });
    void exchange.requestUserInput(params("ui_1"));
    void exchange.requestUserInput(params("ui_2"));
    expect(exchange.describePending().map((entry) => entry.userInputId)).toEqual(["ui_1", "ui_2"]);
  });

  test("userInput.rejectsMalformedRequests", () => {
    const exchange = new UserInputExchange({ timeoutMs: 50 });
    return expect(exchange.requestUserInput({})).rejects.toThrow("unroutable-user-input-request");
  });
});
