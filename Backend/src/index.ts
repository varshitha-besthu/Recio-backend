
import express from "express";
import { PrismaClient } from "../src/generated/prisma/client.js";
import cors from "cors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { AccessToken, WebhookReceiver } from "livekit-server-sdk";
import { router } from "./selfRecording/controller.js";

import bodyParser from "body-parser";

const app = express();
const prisma = new PrismaClient();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

const JWT_SECRET = process.env.JWT_SECRET ;
const API_KEY = process.env.LIVEKIT_API_KEY ;
const API_SECRET = process.env.LIVEKIT_API_SECRET;


app.use("/api", router);

app.get('/', (req, res) => {
  res.sendStatus(200)
})

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
    const { roomName, participantName, role } = req.body;
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

      room = await prisma.room.create({
        data: {
          name: roomName,
          createdBy: { connect: { id: participantId } },
          participants: { connect: { id: participantId } },
        },
        include: { createdBy: true, participants: true },
      });

    } else {
      console.log("role = joiner");
      room = await prisma.room.findUnique({
        where: { name: roomName },
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
            participants: { connect: { id: participantId } },
          },
          include: { participants: true },
        });
      }
    }
    console.log("participant:", participantName);
    console.log("room:", room);
    const token = await createToken({ roomName, participantId, role });
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


app.listen(3000, () => console.log(" Server running on http://localhost:3000"));
