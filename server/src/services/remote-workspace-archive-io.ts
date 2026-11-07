/**
 * Archive passes share the server's event loop with task delivery. A 64 KiB
 * read makes a large snapshot pay that scheduling delay thousands of times.
 * Keep each filesystem stream bounded at 1 MiB instead of buffering an archive.
 * This is an I/O policy only; every caller retains its existing integrity pass.
 */
export const WORKSPACE_ARCHIVE_IO_BUFFER_BYTES = 1024 * 1024;
