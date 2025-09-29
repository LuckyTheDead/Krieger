import faiss, json, os
from sentence_transformers import SentenceTransformer

index = faiss.read_index("index.faiss")
meta = json.load(open("meta.json"))
model = SentenceTransformer('all-MiniLM-L6-v2')
corpus_dir = "web_corpus"

def retrieve(query, k=5):
    q_emb = model.encode([query]).astype("float32")
    D, I = index.search(q_emb, k)
    results = []
    for i in I[0]:
        path = os.path.join(corpus_dir, meta[i]['file'])
        with open(path, 'r', encoding='utf-8', errors='ignore') as f:
            results.append(f.read())
    return results

if __name__ == "__main__":
    import sys
    for r in retrieve(sys.argv[1]):
        print(r)