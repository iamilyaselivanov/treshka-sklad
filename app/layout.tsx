import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "СКЛАД.ОК — учет склада и ремонтов", description: "Мобильный прототип системы складского учета, выдачи и ремонта" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}
