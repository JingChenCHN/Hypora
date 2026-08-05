/**
 * 图片转 base64 工具（§6 / §7 存储设计：base64 内嵌，localStorage 溢出容错）
 * 桌面与 Web 通用：读取文件 → FileReader → data URL。
 */
export async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

export interface ImageBase64Handle {
  openImageDialog: () => Promise<string | null>
  pickImage: () => Promise<{ dataUrl: string; fileName: string } | null>
}

export function useImageBase64(): ImageBase64Handle {
  function pickImage(): Promise<{ dataUrl: string; fileName: string } | null> {
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/*'
      input.onchange = async () => {
        const file = input.files?.[0]
        if (!file) return resolve(null)
        try {
          const dataUrl = await fileToBase64(file)
          resolve({ dataUrl, fileName: file.name })
        } catch {
          resolve(null)
        }
      }
      input.click()
    })
  }

  async function openImageDialog(): Promise<string | null> {
    const res = await pickImage()
    return res?.dataUrl ?? null
  }

  return { openImageDialog, pickImage }
}
