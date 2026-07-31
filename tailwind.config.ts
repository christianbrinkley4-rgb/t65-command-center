import type { Config } from "tailwindcss";

// Warm editorial "command center" system. Cream paper, espresso ink, a burnt
// terracotta primary, and a dark command bar. Signals are warmed to sit in the
// same family instead of the stock blue/slate look.
const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        ink: "#241C15",
        paper: "#F3ECDD",
        line: "#E4D8C2",
        night: "#1B1410",
        "night-line": "#3A2E24",
        "night-soft": "#B8A894",
        brand: {
          DEFAULT: "#C2410C",
          dark: "#9A3412",
          light: "#F7E2CE",
        },
        // Signal colors are tuned to hold WCAG AA 4.5:1 as normal text on
        // white, paper, AND their own -50 tint — verified by contrast math,
        // don't lighten without re-checking.
        overdue: "#B4231C",
        due: "#A34D08",
        week: "#8A5606",
        month: "#0E7490",
        later: "#6E6152",
        verify: "#7C3AED",
        worked: "#6B5E4E",
        newlead: "#136B34",
      },
      fontFamily: {
        sans: ["var(--font-hanken)", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["var(--font-fraunces)", "Georgia", "serif"],
      },
      boxShadow: {
        card: "0 1px 2px 0 rgb(60 40 20 / 0.04), 0 4px 16px -6px rgb(60 40 20 / 0.10)",
        lift: "0 2px 4px 0 rgb(60 40 20 / 0.05), 0 18px 44px -14px rgb(60 40 20 / 0.22)",
        command: "0 1px 0 0 rgb(0 0 0 / 0.3), 0 12px 30px -12px rgb(0 0 0 / 0.5)",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.5s cubic-bezier(0.16, 1, 0.3, 1) both",
        "fade-in": "fade-in 0.4s ease both",
      },
    },
  },
  plugins: [],
};
export default config;
