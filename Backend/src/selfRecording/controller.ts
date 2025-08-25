import ffmpeg from 'fluent-ffmpeg';
import express from "express";
import multer from "multer";
import {v2 as cloudinary} from "cloudinary";
import dotenv from "dotenv";
import fs from "fs";
import cors from "cors";
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { PrismaClient } from '../../src/generated/prisma/client.js';

const app = express();
const upload = multer({ dest: "uploads/" });
export const router = express.Router();
const prisma = new PrismaClient();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME as string,
  api_key: process.env.CLOUDINARY_API_KEY as string,
  api_secret: process.env.CLOUDINARY_API_SECRET as string
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log(__dirname); 
 let urls: string[] = [];

async function getChunksByPrefix(prefix: string): Promise<string[]> {
  const ids: string[] = [];
  let nextCursor: string | undefined = undefined;

  do {
    const res = await cloudinary.api.resources({
      type: "upload",
      resource_type: "raw", 
      prefix,
      max_results: 100,
      next_cursor: nextCursor,
    });

    res.resources.forEach((r: any) => ids.push(r.public_id));
    nextCursor = res.next_cursor;
  } while (nextCursor);

  ids.sort((a, b) => a.localeCompare(b));
  return ids;
}

async function mergeChunksFromPrefix(prefix: string, outputPath: string) {
  const publicIds = await getChunksByPrefix(prefix);
  if (publicIds.length === 0) throw new Error("No chunks found for prefix " + prefix);

  console.log(`Found ${publicIds.length} chunks to merge...`);

  return new Promise<void>(async (resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-f", "webm",          
      "-i", "pipe:0",       
      "-c:v", "libvpx-vp9",  
      "-c:a", "libopus",     
      outputPath
    ]);

    ffmpeg.stderr.on("data", (data) => console.log(data.toString()));

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        console.log("✅ Merge complete:", outputPath);
        resolve();
      } else {
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });

    for (const id of publicIds) {
      const url = cloudinary.url(id, { resource_type: "raw" });
      console.log("Downloading:", url);

      const response = await axios.get(url, { responseType: "stream" });
      await new Promise<void>((res) => {
        response.data.on("end", res);
        response.data.pipe(ffmpeg.stdin, { end: false });
      });
    }

    ffmpeg.stdin.end();
  });
}

export async function mergeAndUpload(prefix: string) {
  const outputFile = path.join(__dirname, "merged.webm");

  await mergeChunksFromPrefix(prefix, outputFile);

  const uploadRes = await cloudinary.uploader.upload(outputFile, {
    resource_type: "video", 
    folder: "merged_videos", 
    public_id: `${prefix}_merged`, 
    overwrite: true
  });

  fs.unlinkSync(outputFile);

  console.log("✅ Uploaded merged video to Cloudinary:", uploadRes.secure_url);
  return uploadRes.secure_url;
}

export async function mergeAndUploadSideBySide(
  participantUrls: string[]
){
  if (!participantUrls || participantUrls.length === 0) {
    throw new Error("No participant videos provided");
  }

  const localFiles: string[] = [];

  for (let i = 0; i < participantUrls.length; i++) {
    const url = participantUrls[i];

    if(!url){
      console.log("url is null or undefined from mergeupload side by side");
      return ;
    }

    const localPath = path.join(__dirname, `participant_${i}.webm`);
    const writer = fs.createWriteStream(localPath);

    console.log(`Downloading participant video ${i} from ${url}`);

    const response = await axios.get(url, { responseType: "stream" });
    response.data.pipe(writer);

    await new Promise<void>((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });
    localFiles.push(localPath);
  }

  if (localFiles.length === 1) {
    console.log("Only one video, skipping merge");
    return participantUrls[0];
  }

  const outputPath = path.join(__dirname, `final_${Date.now()}.webm`);

  const ffmpegArgs: string[] = [];
  localFiles.forEach((f) => ffmpegArgs.push("-i", f));

  const width = 320;  
  const height = 240; 
  const scaleParts = localFiles.map((_, i) => `[${i}:v]scale=${width}:${height}[v${i}]`);
  const layout = localFiles.map((_, i) => `${i * width}_0`).join("|");
  const xstackFilter = `${scaleParts.join(";")};${localFiles.map((_, i) => `[v${i}]`).join("")}xstack=inputs=${localFiles.length}:layout=${layout}[v]`;

  ffmpegArgs.push(
    "-filter_complex", xstackFilter,
    "-map", "[v]",
    "-c:v", "libvpx-vp9",
    "-c:a", "libopus",
    outputPath
  );

  await new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", ffmpegArgs);
    ffmpeg.stderr.on("data", (data) => console.log(data.toString()));
    ffmpeg.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with code ${code}`));
    });
  });

  console.log("✅ Side-by-side merge complete:", outputPath);

  console.log("gonna upload to cloudinary");

  try{
    const uploadResult = await cloudinary.uploader.upload(outputPath, {
      resource_type: "video",
      overwrite: true
    });

    console.log("✅ Uploaded final video to Cloudinary:", uploadResult.secure_url);
    localFiles.forEach((f) => fs.unlinkSync(f));
    fs.unlinkSync(outputPath);

    return uploadResult.secure_url;
  }catch(error){
    console.log("Got an error while uploading to the cloudinary", error);
  }
}

router.post("/get_merged_url", async(req, res) => {
    const merged_url = await mergeAndUploadSideBySide(urls);
    console.log("merged_url is ready", merged_url);
    res.json({"merged_url": merged_url})
})

router.post("/upload_chunk", upload.single("blob"), async(req, res) => {
  const { session_id, participant_id, chunk_index } = req.body;

  if(!req.file){
    console.log("req.file mostly blob is empty");
    res.json({"message" : "blob is empty"})
    return;
  }

  console.log("Chunk received:", { session_id, participant_id, chunk_index, file: req.file.path });

  try{
      const result = await cloudinary.uploader.upload(req.file.path, {
        resource_type:"raw",
        public_id: session_id + "_" + participant_id + "_" + chunk_index
      })
      res.send({"url" : result})
      
    }catch(err : any){
      res.json({"error occured while uploading" : err.message})
    }

})

router.post("/get_url", async (req, res) => {
    const {session_id} = req.body;
    console.log("session_Id", session_id);

    const room = await prisma.room.findUnique({
      where: { id: session_id },  
      include: {
        participants: true,   
      },
    });

    if(!room){
      console.log("Room is null from get_url");
      return;
    }
   

    console.log("room Data from get_url", room.participants);
    const participants = room.participants;

    for (let i = 0; i < participants.length; i++) {
      console.log("participant id in the loop of participants", participants[i]?.id);
      urls[i] = await mergeAndUpload(`${session_id}_${participants[i]?.id}_`);
      console.log("url at index", i, "is", urls[i]);
    }

    console.log("All URLs:", urls);
    res.json({"urls": urls});

  }
)
