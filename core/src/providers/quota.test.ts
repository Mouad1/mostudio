import assert from "node:assert/strict";
import { test } from "node:test";
import { nextReset } from "./quota.ts";

test("nextReset handles the DST change day", () =>
  assert.equal(
    nextReset("America/Los_Angeles", new Date("2026-11-01T12:00:00Z")).toISOString(),
    "2026-11-02T08:00:00.000Z",
  ));

test("nextReset UTC is next 00:00Z", () =>
  assert.equal(
    nextReset("UTC", new Date("2026-11-01T12:00:00Z")).toISOString(),
    "2026-11-02T00:00:00.000Z",
  ));

test("nextReset is strictly after exact midnight", () =>
  assert.equal(
    nextReset("UTC", new Date("2026-11-01T00:00:00Z")).toISOString(),
    "2026-11-02T00:00:00.000Z",
  ));

test("nextReset spring-forward date", () =>
  assert.equal(
    nextReset("America/Los_Angeles", new Date("2027-03-14T12:00:00Z")).toISOString(),
    "2027-03-15T07:00:00.000Z",
  ));
