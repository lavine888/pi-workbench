export function listBooks(books, { status } = {}) {
  return books.filter((book) => status === undefined || book.status === status);
}
