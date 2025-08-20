
import express from "express";
import { PrismaClient } from "../src/generated/prisma/client.js";
import cors from "cors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { AccessToken } from "livekit-server-sdk";
import { router } from "./selfRecording/controller.js";

const app = express();
const prisma = new PrismaClient();

app.use(express.json());
app.use(cors());
const JWT_SECRET = process.env.JWT_SECRET ;

app.use("/api", router);

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
    const { roomName, participantId, role } = req.body;
    let room;
    if (role === "creator") {
      room = await prisma.room.create({
        data: {
          name: roomName,
          createdById: participantId,
        },
      });
    } else {
      room = await prisma.room.findUnique({
        where: { name: roomName },
      });

      if (!room) {
        return res.status(400).json({ error: "Room does not exist" });
      }
    }

    const token = await createToken({ roomName, participantId, role });

    res.json({ token, room, role });
});


app.listen(3000, () => console.log(" Server running on http://localhost:3000"));
