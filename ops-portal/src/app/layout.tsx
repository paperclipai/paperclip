import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Jaban Universe',
  description: 'Operations portal',
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full antialiased">{children}</body>
    </html>
  );
}
