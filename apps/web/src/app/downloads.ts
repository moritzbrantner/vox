// Browser file downloads.

export function downloadJsonFile(filename: string, value: unknown) {
  downloadFile(filename, JSON.stringify(value, null, 2));
}

export function downloadFile(filename: string, payload: string) {
  const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
