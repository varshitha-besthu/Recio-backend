
import express from "express";
import { PrismaClient } from "../src/generated/prisma/client.js";
import cors from "cors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { AccessToken, WebhookReceiver } from "livekit-server-sdk";
import { router } from "./selfRecording/controller.js";
import axios from "axios";
import type { JwtPayload } from "@supabase/supabase-js";

const app = express();
const prisma = new PrismaClient();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

const JWT_SECRET = process.env.JWT_SECRET ;
const API_KEY = process.env.LIVEKIT_API_KEY ;
const API_SECRET = process.env.LIVEKIT_API_SECRET;
const Backend_url = process.env.BACKEND_URL;
const Frontend_url = process.env.FRONTEND_URL;

app.use("/api", router);


app.get("/auth/google", (req, res) => {
  const redirectUri = `${Backend_url}/auth/google/callback`; 
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const scope = "openid email profile";
  const responseType = "code";


  const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=${responseType}&scope=${scope}`;
  
  res.redirect(googleAuthUrl);
});

app.get("/auth/google/callback", async (req, res) => {
  const { code } = req.query;

  const tokenRes = await axios.post("https://oauth2.googleapis.com/token", {
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: `${Backend_url}/auth/google/callback`,
    grant_type: "authorization_code",
  });

  const { id_token } = tokenRes.data;

  const decoded = jwt.decode(id_token);

  if (!decoded || typeof decoded === "string" || !("email" in decoded)) {
    return res.status(400).send("Invalid token");
  }

  const userEmail = (decoded as JwtPayload).email as string;

  let user = await prisma.user.findUnique({
    where: { email: userEmail },
  });

  if (!user) {
    user = await prisma.user.create({
      data: {
        email: userEmail,
        password: "dummy", 
      },
    });
  }
  res.redirect(`${Frontend_url}/auth/callback/?token=${id_token}`);
  
});



app.post("/signup", async (req, res) => {
  try {
    const { email, password } = req.body;

    const existingUser = await prisma.user.findUnique({ where: { email } });

    if (existingUser) {
      return res.status(400).json({ error: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        email: email,
        password: hashedPassword,
      },
    });

    if(!JWT_SECRET){
      res.json({"error" : "jsonwebtoken is missing"});
      return;
    }
    const token = jwt.sign({ userId: user.id }, JWT_SECRET);
    console.log("User Signed up");
    res.json({ token, user: { id: user.id, email: user.email } });

  } catch (err) {
    res.status(500).json({ error: err });
  }
});

app.post("/signin", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(400).json({ error: "Invalid credentials" });

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return res.status(400).json({ error: "Invalid credentials" });

    if(!JWT_SECRET){
      res.json({"error" : "jsonwebtoken is missing"});
      return;
    }
    
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "1h" });
    console.log("Nee valle na")
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    res.status(500).json({ error: err });
  }
});

const createToken = async ({roomName, participantId, role} : {roomName : string, participantId: string, role: "creator" | "guest"}) => {
 
  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity: participantId,
    ttl: '100m',
  });

  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: role === "creator"});
  return await at.toJwt();
};

app.post('/getToken', async (req, res) => {
  try {
    const role= req.body.role;
    const participantName = req.body.participantName;
    let roomName;
    let room;
    let participantId;

    console.log("going to check");
    const participant = await prisma.user.findUnique({
      where: { email: participantName },
    });

    if (!participant) {
      console.log("participant not found");
      return res.status(400).json({ error: "Participant does not exist" });
    }
    participantId = participant.id;


    if (role === "creator") {
      console.log("role = creator");
      roomName = req.body.roomName;
      
      room = await prisma.room.create({
        data: {
          name: roomName,
          createdBy: { connect: { id: participantId } },
          participants: { connect: { id: participantId } },
        },
        include: { createdBy: true, participants: true },
      });

    }
     else {
      console.log("role = joiner");
      const roomId = req.body.roomId; 

      room = await prisma.room.findFirst({
        where: { id: roomId },
        include: { participants: true },
      });

      if (!room) {
        return res.status(400).json({ error: "Room does not exist" });
      }

      const alreadyJoined = room.participants.some(p => p.id === participantId);

      if (!alreadyJoined) {
        room = await prisma.room.update({
          where: { id: room.id },
          data: {
            participants: { connect: { id : participantId } },
          },
          include: { participants: true },
        });
      }
      roomName = room.name

    }
    console.log("participant:", participantName);
    console.log("room:", room);
    const token = await createToken({roomName , participantId: participantName , role });
    res.json({ token, room, role });

  } catch (error) {
    console.error("Error in /getToken:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post('/getRooms', async(req, res) => {
  const { participantName } = req.body;

  const fetchedRooms  = await prisma.user.findMany({
    where: {
      email: participantName
    },
    include:{
      roomsCreated: true,
      roomsJoined: true
    }
  })

  if(!fetchedRooms){
    console.log("No fetched room");
    res.status(200).send("no availabele rooms");
  }

  console.log("We found the rooms bro", fetchedRooms)
  res.json({
    "roomsCreated" : fetchedRooms[0]?.roomsCreated,
    "roomsJoined" : fetchedRooms[0]?.roomsJoined
  })

})

app.post("/prev_mixed_urls", async(req, res) => {
    const {participantName } = req.body;
    try{
      const participant = await prisma.user.findFirst({
        where: {email: participantName}
      })
      if(!participant){
        console.log("No participant with that name");
        res.json("no participant with that name from prev_mixed_urls");
        return;
      }
      console.log("particpant", participant);
      const fetchMixedUrls = await prisma.recording.findMany({
          where: {
            type: "mixed",
            room: {
              createdById: participant.id,
            },
            
          },
          select: {
            id: true,
            url: true,
            createdAt: true,
            roomId: true,
            room: {
              select: {
                name: true
              }
            }
          },
      })
      console.log("fetchedMexedUrls", fetchMixedUrls);
      
      const fetchedUrls = fetchMixedUrls.map(room => ({url: room.url, roomName: room.room.name, roomId: room.roomId}));
      console.log("fetchedUrls", fetchedUrls);

      res.json({"fetchedUrls" :  fetchedUrls})
      
    }catch(error){
      console.log("got an error while fetching the mixed urls", error)
    }
})

app.post("/fetch_users_by_roomId", async(req, res) => {
  const {roomId} = req.body;
    const fetchedUsers = await prisma.room.findMany({
      where: {id: roomId},
      select: {
        participants: true
      }
    })


    console.log("fetchedUsers", fetchedUsers[0]?.participants);
    res.json({"fetchedUsers": fetchedUsers[0]?.participants});
    
})

app.post("/fetch_url_by_userId_roomId_type", async(req, res) => {
    const {roomId, userId, type} = req.body;

    const response = await prisma.recording.findFirst({
      where: {
        roomId: roomId,
        userId: userId,
        type: type
      },
      select: {
        url: true
      }
    });

    console.log("response url from fetch_url_by_userId_roomId_type", response);
    res.json(response);
})


app.listen(3000, () => console.log(" Server running on http://localhost:3000"));
