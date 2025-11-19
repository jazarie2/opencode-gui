import { ipcMain, BrowserWindow, dialog, app } from "electron"
import { processManager } from "./process-manager"
import { randomBytes } from "crypto"
import * as fs from "fs"
import * as path from "path"
import { spawn } from "child_process"
import ignore from "ignore"
import * as https from "https"
import * as http from "http"
import { URL } from "url"
import AdmZip from "adm-zip"

interface Instance {
  id: string
  folder: string
  port: number
  pid: number
  status: "starting" | "ready" | "error" | "stopped"
  error?: string
}

const instances = new Map<string, Instance>()

function generateId(): string {
  return randomBytes(16).toString("hex")
}

function runBinaryVersion(binaryPath: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, ["-v"], {
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    const timeout = setTimeout(() => {
      child.kill("SIGTERM")
      reject(new Error("Version check timed out"))
    }, timeoutMs)

    child.stdout?.on("data", (data) => {
      stdout += data.toString()
    })

    child.stderr?.on("data", (data) => {
      stderr += data.toString()
    })

    child.on("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })

    child.on("close", (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolve(stdout.trim())
      } else {
        reject(new Error(stderr.trim() || `Binary exited with code ${code}`))
      }
    })
  })
}

export function setupInstanceIPC(mainWindow: BrowserWindow) {
  processManager.setMainWindow(mainWindow)

  ipcMain.handle("dialog:selectFolder", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Select Project Folder",
      properties: ["openDirectory"],
    })

    if (result.canceled || !result.filePaths.length) {
      return null
    }

    return result.filePaths[0]
  })

  ipcMain.handle(
    "instance:create",
    async (event, id: string, folder: string, binaryPath?: string, environmentVariables?: Record<string, string>) => {
      const instance: Instance = {
        id,
        folder,
        port: 0,
        pid: 0,
        status: "starting",
      }

      instances.set(id, instance)

      try {
        const {
          pid,
          port,
          binaryPath: actualBinaryPath,
        } = await processManager.spawn(folder, id, binaryPath, environmentVariables)

        instance.port = port
        instance.pid = pid
        instance.status = "ready"

        mainWindow.webContents.send("instance:started", { id, port, pid, binaryPath: actualBinaryPath })

        const meta = processManager.getAllProcesses().get(pid)
        if (meta) {
          meta.childProcess.on("exit", (code, signal) => {
            instance.status = "stopped"
            mainWindow.webContents.send("instance:stopped", { id })
          })
        }

        return { id, port, pid, binaryPath: actualBinaryPath }
      } catch (error) {
        instance.status = "error"
        instance.error = error instanceof Error ? error.message : String(error)

        mainWindow.webContents.send("instance:error", {
          id,
          error: instance.error,
        })

        throw error
      }
    },
  )

  ipcMain.handle("instance:stop", async (event, pid: number) => {
    await processManager.kill(pid)

    for (const [id, instance] of instances.entries()) {
      if (instance.pid === pid) {
        instance.status = "stopped"
        break
      }
    }
  })

  ipcMain.handle("instance:status", async (event, pid: number) => {
    return processManager.getStatus(pid)
  })

  ipcMain.handle("instance:list", async () => {
    return Array.from(instances.values())
  })

  ipcMain.handle("fs:scanDirectory", async (event, workspaceFolder: string) => {
    const ig = ignore()
    ig.add([".git", "node_modules"])

    const gitignorePath = path.join(workspaceFolder, ".gitignore")
    if (fs.existsSync(gitignorePath)) {
      const content = fs.readFileSync(gitignorePath, "utf-8")
      ig.add(content)
    }

    function scanDir(dirPath: string, baseDir: string): string[] {
      const results: string[] = []

      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true })

        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name)
          const relativePath = path.relative(baseDir, fullPath)

          if (ig.ignores(relativePath)) {
            continue
          }

          if (entry.isDirectory()) {
            const dirWithSlash = relativePath + "/"
            if (!ig.ignores(dirWithSlash)) {
              results.push(dirWithSlash)
              const subFiles = scanDir(fullPath, baseDir)
              results.push(...subFiles)
            }
          } else {
            results.push(relativePath)
          }
        }
      } catch (error) {
        console.warn(`Error scanning ${dirPath}:`, error)
      }

      return results
    }

    return scanDir(workspaceFolder, workspaceFolder)
  })

  // OpenCode binary operations
  ipcMain.handle("dialog:selectOpenCodeBinary", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Select OpenCode Binary",
      filters: [
        { name: "Executable Files", extensions: ["exe", "cmd", "bat", "sh", "command", "app", ""] },
        { name: "All Files", extensions: ["*"] },
      ],
      properties: ["openFile"],
    })

    if (result.canceled || !result.filePaths.length) {
      return null
    }

    return result.filePaths[0]
  })

  ipcMain.handle("opencode:validateBinary", async (event, binaryPath: string) => {
    try {
      // Special handling for system PATH binary
      const isSystemPath = binaryPath === "opencode"

      if (!isSystemPath) {
        // Check if file exists and is executable for custom paths
        if (!fs.existsSync(binaryPath)) {
          return { valid: false, error: "File does not exist" }
        }

        const stats = fs.statSync(binaryPath)
        if (!stats.isFile()) {
          return { valid: false, error: "Path is not a file" }
        }
      }

      // Try to get version once via -v flag
      try {
        const version = await runBinaryVersion(binaryPath)
        return { valid: true, version }
      } catch (error) {
        return {
          valid: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  // Download OpenCode binary
  ipcMain.handle("opencode:download", async (event) => {
    const platform = process.platform
    const arch = process.arch

    const sendLog = (message: string) => {
      console.log(`[OpenCode Download] ${message}`)
      mainWindow.webContents.send("opencode:download-log", message)
    }

    try {
      sendLog(`Starting download for platform: ${platform}, arch: ${arch}`)

      // Determine download URL based on platform and architecture
      const baseUrl = "https://github.com/sst/opencode/releases/download/v1.0.78"
      let filename: string
      let binaryName: string

      if (platform === "win32") {
        filename = arch === "arm64" ? "opencode-windows-arm64.zip" : "opencode-windows-x64.zip"
        binaryName = "opencode.exe"
      } else if (platform === "darwin") {
        filename = arch === "arm64" ? "opencode-macos-arm64.zip" : "opencode-macos-x64.zip"
        binaryName = "opencode"
      } else {
        // Linux
        filename = arch === "arm64" ? "opencode-linux-arm64.zip" : "opencode-linux-x64.zip"
        binaryName = "opencode"
      }

      const downloadUrl = `${baseUrl}/${filename}`
      sendLog(`Download URL: ${downloadUrl}`)

      // Check for proxy settings
      const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy
      if (proxyUrl) {
        sendLog(`Using proxy: ${proxyUrl}`)
      } else {
        sendLog("No proxy configured")
      }

      // Create binaries directory in app data
      const configDir = path.join(app.getPath("home"), ".config", "codenomad")
      const binariesDir = path.join(configDir, "binaries")
      sendLog(`Target directory: ${binariesDir}`)
      
      if (!fs.existsSync(binariesDir)) {
        sendLog("Creating binaries directory...")
        fs.mkdirSync(binariesDir, { recursive: true })
      }

      const zipPath = path.join(binariesDir, filename)
      const targetPath = path.join(binariesDir, binaryName)
      sendLog(`Zip download path: ${zipPath}`)
      sendLog(`Target binary path: ${targetPath}`)

      // Download the zip file
      sendLog("Starting download...")
      await downloadFile(
        downloadUrl, 
        zipPath, 
        (progress) => {
          mainWindow.webContents.send("opencode:download-progress", progress)
        },
        sendLog
      )

      sendLog("Download completed successfully")

      // Extract the zip file
      sendLog("Extracting zip file...")
      const zip = new AdmZip(zipPath)
      zip.extractAllTo(binariesDir, true)
      sendLog("Extraction completed")

      // Clean up zip file
      sendLog("Cleaning up zip file...")
      fs.unlinkSync(zipPath)

      // Make executable on Unix-like systems
      if (platform !== "win32") {
        sendLog("Setting executable permissions...")
        fs.chmodSync(targetPath, 0o755)
      }

      sendLog(`Binary installed at: ${targetPath}`)
      return { success: true, path: targetPath }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      sendLog(`Download failed: ${errorMsg}`)
      return {
        success: false,
        error: errorMsg,
      }
    }
  })
}

function downloadFile(
  url: string, 
  targetPath: string, 
  onProgress: (progress: number) => void,
  onLog: (message: string) => void,
  redirectCount = 0
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error("Too many redirects"))
      return
    }

    onLog(`Fetching: ${url} (redirect count: ${redirectCount})`)
    
    const parsedUrl = new URL(url)
    const protocol = parsedUrl.protocol === "https:" ? https : http
    
    onLog(`Protocol: ${parsedUrl.protocol}`)
    onLog(`Host: ${parsedUrl.host}`)
    onLog(`Path: ${parsedUrl.pathname}`)

    // Check for proxy settings
    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy
    
    if (proxyUrl) {
      onLog(`Proxy detected: ${proxyUrl}`)
      onLog(`Note: Direct proxy support is not yet implemented. If download fails, try:`)
      onLog(`1. Temporarily disable proxy`)
      onLog(`2. Download manually from GitHub releases`)
      onLog(`3. Configure system to allow direct GitHub access`)
    }

    const options: https.RequestOptions = {
      timeout: 60000, // 60 second timeout
      headers: {
        "User-Agent": "CodeNomad/1.0",
      },
    }

    const request = protocol.get(url, options, (response) => {
      onLog(`Response status: ${response.statusCode}`)
      
      // Log important headers
      if (response.headers["content-length"]) {
        onLog(`Content-Length: ${response.headers["content-length"]}`)
      }
      if (response.headers["content-type"]) {
        onLog(`Content-Type: ${response.headers["content-type"]}`)
      }

      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 303 || response.statusCode === 307 || response.statusCode === 308) {
        const redirectUrl = response.headers.location
        if (!redirectUrl) {
          reject(new Error("Redirect location not found"))
          return
        }
        onLog(`Redirecting to: ${redirectUrl}`)
        // Resolve relative URLs
        const absoluteRedirectUrl = redirectUrl.startsWith("http") ? redirectUrl : new URL(redirectUrl, url).toString()
        downloadFile(absoluteRedirectUrl, targetPath, onProgress, onLog, redirectCount + 1).then(resolve).catch(reject)
        return
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: HTTP ${response.statusCode} ${response.statusMessage}`))
        return
      }

      const totalBytes = parseInt(response.headers["content-length"] || "0", 10)
      onLog(`Content length: ${totalBytes} bytes (${(totalBytes / 1024 / 1024).toFixed(2)} MB)`)
      
      let downloadedBytes = 0
      let lastLoggedProgress = 0

      const fileStream = fs.createWriteStream(targetPath)

      response.on("data", (chunk) => {
        downloadedBytes += chunk.length
        if (totalBytes > 0) {
          const progress = Math.round((downloadedBytes / totalBytes) * 100)
          onProgress(progress)
          
          // Log progress every 10%
          if (progress >= lastLoggedProgress + 10) {
            onLog(`Downloaded: ${progress}% (${(downloadedBytes / 1024 / 1024).toFixed(2)} MB)`)
            lastLoggedProgress = progress
          }
        }
      })

      response.pipe(fileStream)

      fileStream.on("finish", () => {
        fileStream.close()
        onProgress(100)
        onLog("File download completed")
        resolve()
      })

      fileStream.on("error", (error) => {
        fs.unlink(targetPath, () => {}) // Clean up partial download
        onLog(`File stream error: ${error.message}`)
        reject(error)
      })

      response.on("error", (error) => {
        fs.unlink(targetPath, () => {}) // Clean up partial download
        onLog(`Response error: ${error.message}`)
        reject(error)
      })
    })

    request.on("error", (error) => {
      onLog(`Request error: ${error.message}`)
      if (error.message.includes("ETIMEDOUT")) {
        onLog("Connection timed out. This may be due to:")
        onLog("1. Network connectivity issues")
        onLog("2. Firewall blocking the connection")
        onLog("3. Proxy configuration needed")
        onLog("4. GitHub servers being temporarily unavailable")
        onLog("")
        onLog("Please try:")
        onLog("- Check your internet connection")
        onLog("- Download manually from: https://github.com/opencodetisan/opencode/releases/latest")
        onLog("- Contact your network administrator if behind a corporate firewall")
      } else if (error.message.includes("ENOTFOUND")) {
        onLog("Could not resolve hostname. Please check your DNS settings or internet connection.")
      } else if (error.message.includes("ECONNREFUSED")) {
        onLog("Connection refused. This might be a proxy or firewall issue.")
      }
      reject(error)
    })

    request.on("timeout", () => {
      request.destroy()
      onLog("Request timeout after 60 seconds")
      reject(new Error("Request timeout"))
    })
  })
}
