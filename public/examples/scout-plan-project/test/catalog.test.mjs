import assert from "node:assert/strict";
import test from "node:test";
import { listBooks } from "../src/catalog.mjs";

const books = [
  { id: "one", status: "reading", tags: ["fiction"] },
  { id: "two", status: "unread", tags: ["engineering"] },
  { id: "three", status: "reading", tags: ["engineering", "fiction"] },
];

test("without a filter, return all books in their original order", () => {
  assert.deepEqual(listBooks(books).map((book) => book.id), ["one", "two", "three"]);
});

test("status filtering returns only matching books", () => {
  assert.deepEqual(listBooks(books, { status: "reading" }).map((book) => book.id), ["one", "three"]);
});

test("an unmatched status returns an empty list", () => {
  assert.deepEqual(listBooks(books, { status: "finished" }), []);
});

test("filtering does not change the source collection", () => {
  const before = structuredClone(books);
  listBooks(books, { status: "unread" });
  assert.deepEqual(books, before);
});
