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
let screenShareurls: string[] = [];

async function getChunksByPrefix(prefix: string): Promise<string[]> {

  console.log("prefix from - msg from getChunksByPrefix", prefix);
  const ids: string[] = [];
  let nextCursor: string | undefined = undefined;
  console.log("prefix is", prefix);

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
  console.log("ids - from getChunksByPrefix", ids);
  return ids;
}

async function mergeChunksFromPrefix(prefix: string, outputPath: string) {
  console.log("mergeChunksfromPrefix - msg from mergeChunksfromPrefix", prefix);
  const publicIds = await getChunksByPrefix(prefix);
  if (publicIds.length === 0) {
    console.log("No chunks found for prefix " + prefix);
    return null;
  }

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

    console.log("public Ids", publicIds);

    for (const id of publicIds) {
      console.log("inside the publicIds");
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
  if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
  console.log("prefix is - msg from mergeAndupload", prefix);
  const res = await mergeChunksFromPrefix(prefix, outputFile);

  if(res === null){
    console.log("I didn't found the url - msg from mergeAndUpload function");
    console.log
    return "not found";
  }
  const uploadRes = await cloudinary.uploader.upload(outputFile, {
    resource_type: "raw", 
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

  const videoStack = `${scaleParts.join(";")};${localFiles.map((_, i) => `[v${i}]`).join("")}xstack=inputs=${localFiles.length}:layout=${layout}[v]`;

  const audioMix = `${localFiles.map((_, i) => `[${i}:a]`).join("")}amix=inputs=${localFiles.length}:normalize=0[a]`;

  const filterComplex = `${videoStack};${audioMix}`;
  ffmpegArgs.push(
    "-filter_complex", filterComplex,
    "-map", "[v]",
    "-map", "[a]",
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
      resource_type: "raw",
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
    const {session_Id, urlF} = req.body;
    const merged_url = await mergeAndUploadSideBySide(urlF);

    try {
      await prisma.room.update({
        where: {
            id: session_Id
        },
        data: {
          recordings: {
            create: {
              url: merged_url!,
              type: "mixed"
            }
          }
        }
      })
    }catch(error){
      console.log("something is error in uploading the mixed url");
      res.status(200).json("okay okay, I got error while uploading to the database");
    }
    console.log("merged_url is ready", merged_url);
    res.json({"merged_url": merged_url})
})

router.post("/get_url", async (req, res) => {
    const {sessionId} = req.body;
    console.log("sessionId", sessionId);

    if(!sessionId){
      console.log("sessionId is null");
      res.json({"error": "SessionId in null can't proceed"});
      return;
    }

    const room = await prisma.room.findUnique({
      where: { id: sessionId },  
      include: {
        participants: true,   
      },
    });

    if(!room){
      console.log("Room is null from get_url");
      return;
    }
   
    console.log("room participants Data from get_url", room.participants);
    const participants = room.participants;

    for (let i = 0; i < participants.length; i++) {
      console.log("participant id in the loop of participants", participants[i]?.email);
      urls[i] = await mergeAndUpload(`${sessionId}_${participants[i]?.email}_`);
      screenShareurls[i] = await mergeAndUpload(`${sessionId}_${participants[i]?.email}-screen`)
    

      if(!urls[i]){
        console.log(`Urls${i} is null`);
        continue;
      }
      console.log("url at index", i, "is", urls[i]);
    }

    const pushToDb = await prisma.room.update({
      where: { id: sessionId },
      data: {
        recordings: {
          create: participants.flatMap((p, i) => {
            const recs: any[] = [];
            if (urls[i]) {
              recs.push({
                url: urls[i],
                type: "individual",
                userId: p.id,
              });
            }
            if (screenShareurls[i]) {
              recs.push({
                url: screenShareurls[i],
                type: "individual-screen",
                userId: p.id,
              });
            }
            return recs;
          }),
        },
      },
    });


    console.log("pushToDb" , pushToDb);
    console.log("All URLs:", urls);
    console.log("screenShareUrls", screenShareurls);

    res.json({"urls": urls, "pushToDb" : pushToDb, "screeShareUrls": screenShareurls});

  }
)

router.post("/upload_chunk", upload.single("blob"), async(req, res) => {
  const { session_id, participant_id, chunk_index, type} = req.body;

  if(!req.file){
    console.log("req.file mostly blob is empty");
    res.json({"message" : "blob is empty"})
    return;
  }

  console.log("Chunk received:", { session_id, participant_id, chunk_index, file: req.file.path });

  try{
      let public_id = "";
      if(type === "screenShare"){
        public_id = session_id + "_" + participant_id + "-screen" + chunk_index;
      }else{
        public_id = session_id + "_" + participant_id + "_" +  chunk_index;
      }
      const result = await cloudinary.uploader.upload(req.file.path, {
        resource_type: "raw",   
        public_id: public_id,
        format: "webm"            
      });

      res.send({"url" : result})
      
    }catch(err : any){
      res.json({"error occured while uploading" : err.message})
    }

})

