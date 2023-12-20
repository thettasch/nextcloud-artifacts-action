import * as fsSync from 'fs'
import * as path from 'path'
import * as core from '@actions/core'
import * as os from 'os'
import * as archiver from 'archiver'
import fetch, { HeadersInit } from 'node-fetch'
import btoa from 'btoa'
import { v4 as uuidv4 } from 'uuid'
import * as webdav from 'webdav'
import { URL } from 'url'

const fs = fsSync.promises

interface FileSpec {
  absolutePath: string
  uploadPath: string
}

export class NextcloudClient {
  private guid: string
  private headers: HeadersInit
  private davClient

  constructor(
    private endpoint: URL,
    private artifact: string,
    private rootDirectory: string,
    private username: string,
    private password: string
  ) {
    this.guid = uuidv4()
    this.headers = { Authorization: 'Basic ' + Buffer.from(`${this.username}:${this.password}`).toString('base64') }
    this.davClient = webdav.createClient(`${this.endpoint.href}remote.php/dav/files/${this.username}`, {
      username: this.username,
      password: this.password,
      maxBodyLength: 1024 ** 3
    })
  }

  async uploadFiles(files: string[]): Promise<string> {
    core.info('Preparing upload...')
    const spec = this.uploadSpec(files)
    core.info('Uploading to Nextcloud...')
    let filePath = "NONE"
    for (const s of spec) {
      filePath = await this.upload(s) // Inefficient
    }
    // if (filePath !== "NONE") {
    //   core.info(`Remote file path: ${filePath}`)
    //   return await this.shareFile(filePath)
    // }
    return ""
  }

  private uploadSpec(files: string[]): FileSpec[] {
    const specifications = []
    if (!fsSync.existsSync(this.rootDirectory)) {
      throw new Error(`this.rootDirectory ${this.rootDirectory} does not exist`)
    }
    if (!fsSync.lstatSync(this.rootDirectory).isDirectory()) {
      throw new Error(`this.rootDirectory ${this.rootDirectory} is not a valid directory`)
    }
    let root = path.normalize(this.rootDirectory)
    root = path.resolve(root)
    for (let file of files) {
      if (!fsSync.existsSync(file)) {
        throw new Error(`File ${file} does not exist`)
      }
      if (!fsSync.lstatSync(file).isDirectory()) {
        file = path.normalize(file)
        file = path.resolve(file)
        if (!file.startsWith(root)) {
          throw new Error(`The rootDirectory: ${root} is not a parent directory of the file: ${file}`)
        }

        const uploadPath = file.replace(root, '')
        specifications.push({
          absolutePath: file,
          uploadPath: path.join(this.artifact, uploadPath)
        })
      } else {
        core.debug(`Removing ${file} from rawSearchResults because it is a directory`)
      }
    }
    return specifications
  }

  private async upload(file: FileSpec): Promise<string> {
    const remoteFileDir = `/Software` // Shouldn't be hardcoded
    if (!(await this.davClient.exists(remoteFileDir))) {
      await this.davClient.createDirectory(remoteFileDir, { recursive: true })
    }

    const remoteFilePath = `${remoteFileDir}/${file.uploadPath}`
    core.debug(`Transferring file... (${file.uploadPath})`)

    await this.davClient.putFileContents(remoteFilePath, await fs.readFile(file.absolutePath))

    return remoteFilePath
  }

  private async shareFile(remoteFilePath: string): Promise<string> {
    const url = `${this.endpoint.href}ocs/v2.php/apps/files_sharing/api/v1/shares`
    const body = {
      path: remoteFilePath,
      shareType: 3,
      publicUpload: 'false',
      permissions: 1
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: Object.assign(this.headers, {
        'OCS-APIRequest': true,
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify(body)
    })

    const result = await res.text()
    core.debug(`Share response: ${result}`)
    const re = /<url>(?<share_url>.*)<\/url>/
    const match = re.exec(result)
    core.debug(`Match groups:\n${JSON.stringify(match?.groups)}`)
    const sharableUrl = (match?.groups || {})['share_url']
    if (!sharableUrl) {
      throw new Error(`Failed to parse or find sharable URL:\n${result}`)
    }

    return sharableUrl
  }
}
