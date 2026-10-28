export default {
  webpack: (config) => {
    config.resolve.alias.canvas = false; // pdfjs-dist optional dependency
    return config;
  },
};
