#!/usr/bin/env bash

set -e

echo ""
echo "======================================"
echo " Swiss COPC Potree Viewer"
echo "======================================"
echo ""

mkdir -p vendor

if [ ! -d "vendor/potree/.git" ]; then

    echo "Cloning Potree..."

    git clone \
        --depth 1 \
        --branch develop \
        https://github.com/potree/potree.git \
        vendor/potree

else

    echo "Potree already exists."

fi


echo ""
echo "Installing Potree dependencies..."
echo ""

cd vendor/potree

npm install

echo ""
echo "Building Potree..."
echo ""

npm run build

cd ../..

echo ""
echo "======================================"
echo " Setup complete"
echo "======================================"
echo ""
echo "Start with:"
echo ""
echo "    npm start"
echo ""
echo "Then open:"
echo ""
echo "    http://localhost:8080"
echo ""
