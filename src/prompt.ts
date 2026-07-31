import * as readline from "node:readline/promises";
import {
  createClackPrompter,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup-runtime";

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  hint?: string;
}

// Thin readline wrapper used by the setup wizard. Pulled out so the wizard
// logic can be unit-tested with a stubbed prompter instead of standing up
// a TTY.
export interface Prompter {
  ask(question: string, defaultValue?: string): Promise<string>;
  askSecret?(question: string): Promise<string>;
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  select?<T extends string>(
    question: string,
    options: Array<SelectOption<T>>,
    defaultValue?: T,
  ): Promise<T>;
  close(): Promise<void> | void;
}

export function adaptOpenClawPrompter(native: WizardPrompter): Prompter {
  return {
    ask: (question, defaultValue) =>
      native.text({
        message: question,
        ...(defaultValue !== undefined ? { initialValue: defaultValue } : {}),
      }),
    askSecret: (question) => native.text({ message: question, sensitive: true }),
    confirm: (question, defaultYes = true) =>
      native.confirm({ message: question, initialValue: defaultYes }),
    select: (question, options, defaultValue) =>
      native.select({
        message: question,
        options,
        ...(defaultValue !== undefined ? { initialValue: defaultValue } : {}),
      }),
    close: () => {},
  };
}

export function createOpenClawPrompter(): Prompter {
  return adaptOpenClawPrompter(createClackPrompter());
}

export function createReadlinePrompter(): Prompter {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = async (question: string, defaultValue?: string): Promise<string> => {
    const suffix = defaultValue !== undefined && defaultValue !== "" ? ` [${defaultValue}]` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || (defaultValue ?? "");
  };

  const confirm = async (question: string, defaultYes = true): Promise<boolean> => {
    const suffix = defaultYes ? "[Y/n]" : "[y/N]";
    const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
    if (answer === "") return defaultYes;
    return answer === "y" || answer === "yes";
  };

  return {
    ask,
    confirm,
    close: () => rl.close(),
  };
}
