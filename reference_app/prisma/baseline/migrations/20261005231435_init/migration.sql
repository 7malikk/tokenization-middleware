-- CreateTable
CREATE TABLE "baseline_customer" (
    "id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "bvn" CHAR(11) NOT NULL,

    CONSTRAINT "baseline_customer_pkey" PRIMARY KEY ("id")
);
