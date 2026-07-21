import type { Metadata } from "next";
import "./globals.css";
export const metadata:Metadata={
  metadataBase:new URL("https://sklad-ok-prototype.janfoody2016.chatgpt.site"),
  title:"ТРЁШКА СКЛАД",
  description:"Прототип системы складского учета, выдачи и ремонта",
  openGraph:{title:"ТРЁШКА СКЛАД",description:"Учет, выдача и ремонт",images:["/og.png"]},
  twitter:{card:"summary_large_image",title:"ТРЁШКА СКЛАД",description:"Учет, выдача и ремонт",images:["/og.png"]}
};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="ru"><body>{children}</body></html>}
