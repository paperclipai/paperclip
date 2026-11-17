import { describe, expect, it } from "vitest";
import { parseAddressList } from "./address.js";

const cases: Array<[string, string | undefined, string[]]> = [
  ["no header", undefined, []],
  ["empty header", "", []],
  ["plain address", "a@example.test", ["a@example.test"]],
  ["display name with angle address", "Avery Example <avery@example.test>", ["avery@example.test"]],
  ["quoted display name with a comma", "\"Doe, Drew\" <drew@example.test>", ["drew@example.test"]],
  ["quoted display name with a colon", "\"Odd: name\" <d@example.test>", ["d@example.test"]],
  ["quoted display name with an escaped quote", "\"Al \\\"Ace\\\" Ray\" <al@example.test>", ["al@example.test"]],
  ["quoted local part with a space, bare", "\"john doe\"@example.test", ["\"john doe\"@example.test"]],
  ["quoted local part with a space, in angle brackets", "John <\"john doe\"@example.test>", ["\"john doe\"@example.test"]],
  ["quoted local part with an escaped quote, bare", "\"a\\\"b\"@example.test", ["\"a\\\"b\"@example.test"]],
  ["quoted local part with an escaped quote, in angle brackets", "<\"a\\\"b\"@example.test>", ["\"a\\\"b\"@example.test"]],
  ["quoted local part with an escaped backslash, bare", "\"a\\\\b c\"@example.test", ["\"a\\\\b c\"@example.test"]],
  ["quoted local part with an escaped backslash, in angle brackets", "X <\"a\\\\b c\"@example.test>", ["\"a\\\\b c\"@example.test"]],
  ["bare address with folding space around the at-sign", "a @ example.test", ["a@example.test"]],
  ["trailing comment", "Avery <avery@example.test> (work)", ["avery@example.test"]],
  ["nested comment", "blake@example.test (Blake, (home: desk))", ["blake@example.test"]],
  ["comment with an escaped parenthesis", "c@example.test (a \\) b)", ["c@example.test"]],
  ["group with two members", "Team: a@example.test, Bea <b@example.test>;", ["a@example.test", "b@example.test"]],
  ["empty group", "undisclosed-recipients:;", []],
  ["group then a mailbox", "Team: a@example.test;, c@example.test", ["a@example.test", "c@example.test"]],
  ["IPv6 domain literal, bare", "ops@[IPv6:2001:db8::1]", ["ops@[IPv6:2001:db8::1]"]],
  ["IPv6 domain literal, in angle brackets", "Ops <ops@[IPv6:2001:db8::1]>", ["ops@[IPv6:2001:db8::1]"]],
  ["IPv6 domain literal inside a group", "Lab: ops@[IPv6:2001:db8::1];", ["ops@[IPv6:2001:db8::1]"]],
  ["source route in angle brackets", "<@relay.example.test:e@example.test>", ["e@example.test"]],
  [
    "mixed list",
    "\"Doe, Drew\" <drew@example.test>, e@example.test (x), Team: f@example.test, \"G: H\" <g@example.test>;, ops@[IPv6:2001:db8::1]",
    ["drew@example.test", "e@example.test", "f@example.test", "g@example.test", "ops@[IPv6:2001:db8::1]"],
  ],
  ["unclosed angle bracket", "Avery <avery@example.test", ["avery@example.test"]],
  ["unclosed quote", "\"Avery <avery@example.test>", ["avery@example.test"]],
  ["unclosed comment", "a@example.test (oops", ["a@example.test"]],
  ["unclosed domain literal", "ops@[IPv6:2001:db8::1", ["ops@[IPv6:2001:db8::1"]],
  ["stray separators", ",,;; ,", []],
  ["name without an address", "Just A Name", []],
];

describe("parseAddressList", () => {
  it.each(cases)("%s", (_name, header, expected) => {
    expect(parseAddressList(header)).toEqual(expected);
  });

  it("never throws on arbitrary input", () => {
    const alphabet = ["a", "@", ".", ",", ";", ":", "<", ">", "(", ")", "[", "]", "\"", "\\", " ", "é"];
    let seed = 7;
    for (let round = 0; round < 2000; round += 1) {
      let text = "";
      for (let index = 0; index < 24; index += 1) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        text += alphabet[seed % alphabet.length];
      }
      expect(() => parseAddressList(text)).not.toThrow();
      expect(Array.isArray(parseAddressList(text))).toBe(true);
    }
  });
});
