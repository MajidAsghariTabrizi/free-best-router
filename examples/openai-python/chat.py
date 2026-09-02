"""
Example: Free Best Router via the openai-python SDK.

Run:
    pip install openai
    python chat.py
"""
from openai import OpenAI

# The router accepts any value for api_key — it does not validate the inbound
# bearer. Use a placeholder.
client = OpenAI(
    base_url="http://127.0.0.1:4098/v1",
    api_key="not-validated",
)


def main():
    # Non-streaming
    response = client.chat.completions.create(
        model="free-best",
        messages=[
            {"role": "system", "content": "You are a concise assistant."},
            {"role": "user", "content": "What is the capital of France?"},
        ],
        max_tokens=64,
    )
    print("=== non-streaming ===")
    print("picked model:", response.model)
    print("content:", response.choices[0].message.content)

    # Streaming
    print("\n=== streaming ===")
    stream = client.chat.completions.create(
        model="free-best",
        messages=[{"role": "user", "content": "Write a haiku about open source."}],
        max_tokens=64,
        stream=True,
    )
    for chunk in stream:
        delta = chunk.choices[0].delta.content
        if delta:
            print(delta, end="", flush=True)
    print()


if __name__ == "__main__":
    main()
