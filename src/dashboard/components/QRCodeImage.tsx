import { useEffect, useState } from "react"
import QRCode from "qrcode"

type Props = {
  value: string
  size?: number
}

export function QRCodeImage({ value, size = 200 }: Props) {
  const [dataUrl, setDataUrl] = useState("")

  useEffect(() => {
    QRCode.toDataURL(value, {
      width: size,
      margin: 2,
      color: { light: "#0a0a0a", dark: "#ffffff" },
    }).then(setDataUrl).catch(() => {})
  }, [value, size])

  if (!dataUrl) {
    return <div style={{ width: size, height: size }} className="rounded-xl bg-white/5 animate-pulse" />
  }
  return <img src={dataUrl} width={size} height={size} className="rounded-xl" alt="QR code" />
}
