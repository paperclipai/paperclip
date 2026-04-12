import { describe, expect, it } from "vitest";
import { parseMentions, scoreTopicMatch } from "../services/rooms.ts";

// ── scoreTopicMatch ──

describe("scoreTopicMatch", () => {
  it("returns 0 for null/empty topics", () => {
    expect(scoreTopicMatch("서버 API 느려", null)).toBe(0);
    expect(scoreTopicMatch("서버 API 느려", [])).toBe(0);
  });

  it("counts distinct matching keywords", () => {
    const topics = ["서버", "API", "DB", "배포", "인프라"];
    expect(scoreTopicMatch("서버 API 스키마 변경해야 할 것 같은데", topics)).toBe(2);
  });

  it("is case-insensitive", () => {
    const topics = ["WebGL", "렌더링"];
    expect(scoreTopicMatch("webgl 렌더링 이슈", topics)).toBe(2);
  });

  it("handles Unicode normalization (NFKC)", () => {
    const topics = ["디자인"];
    // composed vs decomposed — both should match
    expect(scoreTopicMatch("디자인 리뷰", topics)).toBe(1);
  });

  it("returns 0 when no keyword matches", () => {
    const topics = ["서버", "API", "DB"];
    expect(scoreTopicMatch("진행상황 어때요?", topics)).toBe(0);
  });

  it("returns 1 for single ambiguous match", () => {
    const topics = ["테스트", "QA", "버그", "리뷰", "검증"];
    expect(scoreTopicMatch("리뷰 준비되가나요?", topics)).toBe(1);
  });

  it("does NOT match Latin substring false positives (UI in guid)", () => {
    const topics = ["UI", "UX"];
    expect(scoreTopicMatch("this guid is unique", topics)).toBe(0);
    expect(scoreTopicMatch("building the project", topics)).toBe(0);
  });

  it("DOES match Latin keyword at word boundary", () => {
    const topics = ["UI", "UX"];
    expect(scoreTopicMatch("UI 컴포넌트 수정", topics)).toBe(1);
    expect(scoreTopicMatch("fix the UI component", topics)).toBe(1);
  });

  it("matches Korean keywords with agglutinated particles (조사)", () => {
    const topics = ["렌더링", "서버"];
    expect(scoreTopicMatch("렌더링이 깨지고 서버에서 에러남", topics)).toBe(2);
  });

  it("ignores topics shorter than 2 chars", () => {
    const topics = ["A", "서", "DB"];
    expect(scoreTopicMatch("A서 DB 확인", topics)).toBe(1); // only DB
  });

  it("handles non-string values in topics array defensively", () => {
    const topics = [null as unknown as string, 42 as unknown as string, "API"];
    expect(scoreTopicMatch("API 호출", topics)).toBe(1);
  });
});

// ── parseMentions — @all / @everyone / @전체 / @모두 ──

describe("parseMentions @all variants", () => {
  it("parses @all", () => {
    expect(parseMentions("@all 이번 스프린트 회고하자")).toContain("all");
  });

  it("parses @everyone", () => {
    expect(parseMentions("@everyone 회의 시작")).toContain("everyone");
  });

  it("parses @전체", () => {
    expect(parseMentions("@전체 공지사항")).toContain("전체");
  });

  it("parses @모두", () => {
    expect(parseMentions("@모두 확인 부탁")).toContain("모두");
  });
});

// ── Scenario tests (topic scoring logic) ──

describe("speaker control scenarios", () => {
  const felix = { topics: ["서버", "API", "DB", "마이그레이션", "배포", "인프라", "백엔드"] };
  const cyrus = { topics: ["WebGL", "렌더링", "엔진", "셰이더", "성능", "캔버스"] };
  const iris = { topics: ["테스트", "QA", "버그", "리뷰", "검증", "리그레션"] };
  const noel = { topics: ["디자인", "UI", "UX", "컴포넌트", "스타일", "프론트엔드", "레이아웃"] };

  function bestMatch(body: string): string {
    const scores = [
      { name: "Felix", score: scoreTopicMatch(body, felix.topics) },
      { name: "Cyrus", score: scoreTopicMatch(body, cyrus.topics) },
      { name: "Iris", score: scoreTopicMatch(body, iris.topics) },
      { name: "Noel", score: scoreTopicMatch(body, noel.topics) },
    ];
    scores.sort((a, b) => b.score - a.score);
    return scores[0].score >= 2 ? scores[0].name : "coordinator";
  }

  it("scenario 1: '진행상황 어때요?' → coordinator (no match)", () => {
    expect(bestMatch("지금 진행상황 어때요?")).toBe("coordinator");
  });

  it("scenario 2: '이슈 상황 어때요?' → coordinator (no match)", () => {
    expect(bestMatch("지금 이슈 상황 어때요?")).toBe("coordinator");
  });

  it("scenario 3: '리뷰 준비되가나요?' → coordinator (1-point ambiguous)", () => {
    expect(bestMatch("리뷰 준비되가나요?")).toBe("coordinator");
  });

  it("scenario 4: '서버 API 스키마 변경' → Felix (2+ match)", () => {
    expect(bestMatch("서버 API 스키마 변경해야 할 것 같은데")).toBe("Felix");
  });

  it("scenario 5: 'WebGL 렌더링 깨짐' → Cyrus (2+ match)", () => {
    expect(bestMatch("WebGL 렌더링이 깨지는 것 같아")).toBe("Cyrus");
  });

  it("scenario 6: 'UI 컴포넌트 스타일 수정' → Noel (3 match)", () => {
    expect(bestMatch("UI 컴포넌트 스타일 수정해야 해")).toBe("Noel");
  });

  it("scenario 7: 'QA 버그 리그레션 확인' → Iris (3 match)", () => {
    expect(bestMatch("QA 버그 리그레션 확인 부탁")).toBe("Iris");
  });
});
