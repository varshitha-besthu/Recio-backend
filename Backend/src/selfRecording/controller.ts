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
import { PrismaClient } from '@prisma/client/extension';


const app = express();
const upload = multer({ dest: "uploads/" });
const prisma = new PrismaClient();
export const router = express.Router();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME as string,
  api_key: process.env.CLOUDINARY_API_KEY as string,
  api_secret: process.env.CLOUDINARY_API_SECRET as string
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log(__dirname); 

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

    // Stream chunks into ffmpeg.stdin
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

router.post("/get_url", async (req, res) => {
  const {session_id} = req.body;
  console.log("session_Id", session_id);

  const participants = await prisma.room.findMany({
    
  })

  const url = await mergeAndUpload(`${session_id}_`);

  res.json({"url": url});
})

