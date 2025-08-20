-- DropForeignKey
ALTER TABLE "public"."Room" DROP CONSTRAINT "Room_createdById_fkey";

-- AddForeignKey
ALTER TABLE "public"."Room" ADD CONSTRAINT "Room_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("email") ON DELETE RESTRICT ON UPDATE CASCADE;
