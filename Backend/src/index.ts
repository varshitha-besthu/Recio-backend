
import express from "express";
import { PrismaClient } from "../src/generated/prisma/client.js";
import cors from "cors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { AccessToken } from "livekit-server-sdk";

const app = express();
const prisma = new PrismaClient();

app.use(express.json());
app.use(cors());
const JWT_SECRET = process.env.JWT_SECRET ;
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


const createToken = async ({roomName, participantId} : {roomName : string, participantId: string}) => {
 
  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity: participantId,
    ttl: '100m',
  });
  at.addGrant({ roomJoin: true, room: roomName });

  return await at.toJwt();
};

app.post('/getToken', async (req, res) => {
  const {roomName, participantId} = req.body;
  const token = await createToken({roomName, participantId});

  res.json({"token" : token});
});


app.listen(3000, () => console.log(" Server running on http://localhost:3000"));
