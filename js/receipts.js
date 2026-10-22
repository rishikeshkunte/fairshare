export function compressImage(dataUrl, maxEdge = 1280, quality = 0.72) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    image.onerror = () => resolve(dataUrl);
    image.src = dataUrl;
  });
}

export function safeImageSrc(src) {
  if (typeof src !== "string" || !src) return "";
  if (src.startsWith("data:image/") || src.startsWith("blob:") || src.startsWith("https://")) return src;
  return "";
}
