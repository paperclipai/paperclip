import { describe, it, expect } from "vitest";
import {
  classifyOpportunity,
  isFederal,
  isJobPosting,
  isRfi,
  isOngoing,
} from "../classify.js";

describe("isFederal — US-7", () => {
  it("flags federal agencies", () => {
    for (const agency of [
      "U.S. National Aeronautics and Space Administration",
      "United States Department of Energy",
      "Department of Defense",
      "U.S. Army Corps of Engineers",
      "General Services Administration",
      "Department of Veterans Affairs",
      "NASA",
    ]) {
      expect(isFederal({ agency }), agency).toBe(true);
    }
  });

  it("does NOT flag state/local agencies or US-named vendors", () => {
    for (const agency of [
      "California Department of Technology",
      "State of Maryland Government",
      "City of Redwood City",
      "Texas Department of Transportation",
      "US Bank", // vendor, not federal
      "Union County",
    ]) {
      expect(isFederal({ agency }), agency).toBe(false);
    }
  });
});

describe("isJobPosting — US-8", () => {
  it("flags single salaried roles and pure staffing", () => {
    for (const title of [
      "Director of Information Systems",
      "Manager of IT Operations",
      "RFP - IT Coordinator for the District",
      "Temporary Staffing Services",
      "Contingent and Temporary Staffing",
      "Substitute Employee Staffing Services",
    ]) {
      expect(isJobPosting({ title }), title).toBe(true);
    }
  });

  it("does NOT flag services/project engagements (default rule)", () => {
    for (const title of [
      "IT Director Services", // managed service, not a hire
      "ERP Implementation including a Project Manager",
      "Managed IT Services",
      "Cybersecurity Assessment Services",
      "Data Analytics Platform Implementation",
    ]) {
      expect(isJobPosting({ title }), title).toBe(false);
    }
  });
});

describe("isRfi — US-9", () => {
  it("flags RFIs, Sources Sought, Pre-Solicitation", () => {
    for (const title of [
      "RFI for Enterprise Cloud Brokerage Service",
      "SharePoint Migration Services - RFI",
      "Request for Information - ERP",
      "Sources Sought: IT Support",
      "Pre-Solicitation Notice - Data Platform",
      "RFEI for Managed Services",
    ]) {
      expect(isRfi({ title }), title).toBe(true);
    }
  });

  it("does NOT match substrings inside other words", () => {
    for (const title of [
      "Identity Verification Services",
      "Notification System Implementation",
      "Classified Records Management",
    ]) {
      expect(isRfi({ title }), title).toBe(false);
    }
  });
});

describe("isOngoing — US-10", () => {
  it("flags no-deadline and continuous solicitations", () => {
    expect(isOngoing({ dueDate: null, title: "ERP Support" })).toBe(true);
    expect(isOngoing({ dueDate: "2026-07-01", title: "On-Call IT Services (ongoing)" })).toBe(true);
    expect(isOngoing({ dueDate: "2026-07-01", title: "Open Enrollment IT Staffing 2026" })).toBe(true);
  });
  it("a dated, non-continuous RFP is NOT ongoing", () => {
    expect(isOngoing({ dueDate: "2026-07-01", title: "ERP Implementation Services" })).toBe(false);
  });
});

describe("classifyOpportunity — precedence + routing", () => {
  const c = (title: string, agency = "City of Springfield", dueDate: string | null = "2026-07-01") =>
    classifyOpportunity({ title, agency, dueDate });

  it("defaults to rfp", () => {
    expect(c("Managed IT Services").type).toBe("rfp");
  });
  it("routes RFI", () => {
    expect(c("RFI for Cloud Services").type).toBe("rfi");
  });
  it("routes federal over rfi (precedence)", () => {
    expect(c("RFI for Data Platform", "U.S. Department of Energy").type).toBe("federal");
  });
  it("routes job-posting", () => {
    expect(c("Director of Information Systems").type).toBe("job-posting");
  });
  it("Q&A and addendum take precedence over federal", () => {
    expect(c("Addendum 2 - Answers to Vendor Questions", "U.S. Army").type).toBe("qanda");
    expect(c("Addendum 1 - Revised Scope", "U.S. Army").type).toBe("addendum");
  });
  it("carries the ongoing flag independently", () => {
    expect(c("Managed IT Services", "City of X", null)).toEqual({ type: "rfp", ongoing: true });
  });
});
