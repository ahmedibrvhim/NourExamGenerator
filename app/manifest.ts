import type { MetadataRoute } from "next";

// Lets the site be installed on a phone ("Add to Home Screen") and open full-screen like an app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "سنتر النور التعليمي — مولّد الاختبارات",
    short_name: "سنتر النور",
    description: "حوّل ملفات PDF إلى اختبارات بعدة نسخ جاهزة للتنزيل.",
    lang: "ar",
    dir: "rtl",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#030c12",
    theme_color: "#030c12",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
