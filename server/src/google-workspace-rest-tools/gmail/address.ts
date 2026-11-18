interface Mailbox {
  outside: string;
  angle: string;
  hasAngle: boolean;
}

const emptyMailbox = (): Mailbox => ({ outside: "", angle: "", hasAngle: false });

function withoutRoute(angle: string): string {
  if (!angle.startsWith("@")) return angle;
  let bracket = false;
  for (let index = 0; index < angle.length; index += 1) {
    const char = angle[index];
    if (char === "[") bracket = true;
    else if (char === "]") bracket = false;
    else if (char === ":" && !bracket) return angle.slice(index + 1);
  }
  return angle;
}

function withoutUnquotedSpace(text: string): string {
  let result = "";
  let quoted = false;
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      escaped = false;
      result += char;
      continue;
    }
    if (quoted && char === "\\") {
      escaped = true;
      result += char;
      continue;
    }
    if (char === "\"") quoted = !quoted;
    if (!quoted && /\s/.test(char)) continue;
    result += char;
  }
  return result;
}

function mailboxAddress(mailbox: Mailbox): string | null {
  if (mailbox.hasAngle) {
    const address = withoutRoute(mailbox.angle.trim()).trim();
    return address.length > 0 ? address : null;
  }
  const address = withoutUnquotedSpace(mailbox.outside);
  const enclosed = /<([^<>]*@[^<>]*)>?/.exec(address);
  if (enclosed) return enclosed[1]!.trim();
  return address.includes("@") && !/[<>]/.test(address) ? address : null;
}

export function parseAddressList(value: string | undefined): string[] {
  if (!value) return [];
  const addresses: string[] = [];
  let mailbox = emptyMailbox();
  let quoted = false;
  let comment = 0;
  let angle = false;
  let bracket = false;
  let escaped = false;

  const append = (text: string) => {
    if (angle) mailbox.angle += text;
    else mailbox.outside += text;
  };
  const finish = () => {
    const address = mailboxAddress(mailbox);
    if (address) addresses.push(address);
    mailbox = emptyMailbox();
  };

  for (const char of value) {
    if (escaped) {
      escaped = false;
      if (comment === 0) append(char);
      continue;
    }
    if (char === "\\" && (quoted || comment > 0 || bracket)) {
      escaped = true;
      if (comment === 0) append(char);
      continue;
    }
    if (comment > 0) {
      if (char === "(") comment += 1;
      else if (char === ")") comment -= 1;
      continue;
    }
    if (quoted) {
      append(char);
      if (char === "\"") quoted = false;
      continue;
    }
    if (bracket) {
      append(char);
      if (char === "]") bracket = false;
      continue;
    }
    if (char === "(") {
      comment = 1;
      append(" ");
      continue;
    }
    if (char === "\"") {
      quoted = true;
      append(char);
      continue;
    }
    if (char === "[") {
      bracket = true;
      append(char);
      continue;
    }
    if (angle) {
      if (char === ">") angle = false;
      else append(char);
      continue;
    }
    if (char === "<") {
      angle = true;
      mailbox.hasAngle = true;
      mailbox.angle = "";
      continue;
    }
    if (char === ":") {
      mailbox = emptyMailbox();
      continue;
    }
    if (char === "," || char === ";") {
      finish();
      continue;
    }
    append(char);
  }
  finish();
  return addresses;
}
