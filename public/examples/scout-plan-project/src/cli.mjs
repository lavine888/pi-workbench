import { readFileSync } from "node:fs";
import { listBooks } from "./catalog.mjs";

const args = process.argv.slice(2);
let status;
for (let index = 0; index < args.length; index++) {
  if (args[index] !== "--status" || !args[index + 1]) {
    console.error("Usage: node src/cli.mjs [--status unread|reading|finished]");
    process.exit(2);
  }
  status = args[++index];
  if (!["unread", "reading", "finished"].includes(status)) {
    console.error("Unknown status; choose unread, reading, or finished.");
    process.exit(2);
  }
}

const books = JSON.parse(readFileSync(new URL("../data/books.json", import.meta.url), "utf8"));
for (const book of listBooks(books, { status })) {
  console.log(`${book.id}\t${book.title}\t${book.status}\t${book.tags.join(",")}`);
}
