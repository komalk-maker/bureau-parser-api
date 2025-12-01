import express from "express";
import multer from "multer";
import pdf from "pdf-parse";
import cors from "cors";
import fs from "fs";
import { parseBureauReport } from "./parser.js";

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: "uploads/" });

app.post("/analyze", upload.single("pdf"), async (req, res) => {
    try {
        const filePath = req.file.path;

        const dataBuffer = fs.readFileSync(filePath);
        const pdfData = await pdf(dataBuffer);
        const extractedText = pdfData.text;

        const result = parseBureauReport(extractedText);

        // Remove the uploaded file
        fs.unlinkSync(filePath);

        res.json({
            success: true,
            message: "PDF parsed successfully",
            result
        });

    } catch (err) {
        console.log(err);
        res.status(500).json({ success: false, message: "Error parsing PDF" });
    }
});

app.get("/", (req, res) => {
    res.send("Bureau Parser API Working");
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
