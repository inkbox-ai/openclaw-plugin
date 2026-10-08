/** Destination-specific guidance, never applied to email, phone, or local terminal turns. */
export const SLACK_STYLE_PROMPT = `This turn is on Slack. Use Slack mrkdwn: *bold* (not **bold**), _italic_, and <https://example.com|label> links (not [label](url)). Prefer short paragraphs and simple lists; avoid Markdown headings and tables. Preserve code in backticks/code fences. Ordinary final text is delivered automatically to this exact source conversation and thread. To deliver a generated image or other local file, use inkbox_slack_upload_file with its real filePath; saying “attached” or showing a filesystem path does not upload a file. Only claim file delivery after its operation reports succeeded. Tool progress is displayed separately: do not narrate tool calls, raw arguments, local paths, delegation IDs, or emoji status spam in final replies.`;

/** Conservative repair outside code; complex Markdown is left intact rather than guessed. */
export function slackMrkdwn(text: string): string {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, index) =>
      index % 2
        ? part
        : part
            .replace(
              /\[([^\]\n]+)\]\((https?:\/\/[^\s()<>]+)\)/g,
              (_match, label, url) =>
                `<${url.replaceAll("&", "&amp;")}|${label.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}>`,
            )
            .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
            .replace(/^#{1,6} (.+)$/gm, "*$1*"),
    )
    .join("");
}
