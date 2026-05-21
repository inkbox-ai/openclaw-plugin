import * as readline from "node:readline/promises";

// Thin readline wrapper used by the setup wizard. Pulled out so the wizard
// logic can be unit-tested with a stubbed prompter instead of standing up
// a TTY.
export interface Prompter {
  ask(question: string, defaultValue?: string): Promise<string>;
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  close(): Promise<void> | void;
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
