import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import Shell from "@/components/Shell";
import { PlatformProvider } from "@/components/PlatformContext";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: { default: "KubeAdvisor", template: "%s · KubeAdvisor" },
  description: "Learn Kubernetes the way SREs do: real clusters, real faults, real manifests. Manifest builders, GitOps with Flux and Helm, cluster components, loaded troubleshooting scenarios, and exam-preparation courses.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="font-sans antialiased"><PlatformProvider><Shell>{children}</Shell></PlatformProvider></body>
    </html>
  );
}
